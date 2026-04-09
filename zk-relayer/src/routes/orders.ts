import { Router, Request, Response, RequestHandler } from "express";
import type { PrivateOrderbook } from "../core/orderbook.js";
import type { PrivateMatcher } from "../core/matcher.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { parsePrivateOrder, serializePrivateOrder, isCrossRelayerMatch, type PrivateOrderStatus } from "../types/order.js";
import { poseidonHash, verifyEdDSA, computeClaimLeaf, buildMerkleTree } from "../core/zk-prover.js";
import { config } from "../config.js";
import type { SharedOrderbookClient } from "../core/shared-orderbook-client.js";
import type { CrossRelayerMatchService } from "../core/cross-relayer-matcher.js";

export function createPrivateOrderRoutes(
  orderbook: PrivateOrderbook,
  matcher: PrivateMatcher,
  submitter: PrivateSubmitter,
  writeLimiter?: RequestHandler,
  readLimiter?: RequestHandler,
  sharedClient?: SharedOrderbookClient | null,
  crossRelayerService?: CrossRelayerMatchService | null,
  orderIdMap?: Map<string, string>,
): Router {
  const router = Router();

  // POST /api/private-orders — submit a private order
  if (writeLimiter) router.post("/", writeLimiter);
  router.post("/", async (req: Request, res: Response) => {
    try {
      const order = parsePrivateOrder(req.body);

      // Compute claimsRoot from order claims to include in signature verification
      const claimLeafHashes = await Promise.all(
        order.claims.map((c) => computeClaimLeaf(c))
      );
      const padded = [...claimLeafHashes];
      while (padded.length < 16) padded.push(0n);
      const { root: claimsRoot } = await buildMerkleTree(padded, 4);

      // Verify EdDSA signature (includes claimsRoot to prevent relayer manipulation)
      const msgHash = await poseidonHash([
        order.sellToken, order.buyToken,
        order.sellAmount, order.buyAmount,
        order.maxFee, order.expiry, order.nonce,
        claimsRoot,
      ]);

      const valid = await verifyEdDSA(
        msgHash,
        [order.pubKeyAx, order.pubKeyAy],
        { S: order.sigS, R8x: order.sigR8x, R8y: order.sigR8y },
      );

      if (!valid) {
        res.status(400).json({ error: "invalid EdDSA signature" });
        return;
      }

      // Check expiry
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (order.expiry <= now) {
        res.status(400).json({ error: "order expired" });
        return;
      }

      // Check fee
      if (BigInt(config.relayerFee) > order.maxFee) {
        res.status(400).json({ error: "relayer fee exceeds order maxFee" });
        return;
      }

      // Dedup
      if (orderbook.hasNonce(order.pubKeyAx, order.nonce)) {
        res.status(400).json({ error: "duplicate nonce" });
        return;
      }

      // Same-token order: scatter direct (no counterparty needed)
      if (order.sellToken === order.buyToken) {
        const stored = orderbook.add(order);
        stored.status = "matched";
        orderbook.persistStatus(order.pubKeyAx, order.nonce, "matched");

        try {
          const txHash = await submitter.submitScatterDirect(order);
          stored.status = "settled";
          stored.settleTxHash = txHash;
          orderbook.persistStatus(order.pubKeyAx, order.nonce, "settled", txHash);
          res.json({ status: "settled", txHash });
        } catch (err: unknown) {
          stored.status = "pending";
          orderbook.persistStatus(order.pubKeyAx, order.nonce, "pending");
          console.error("scatterDirect failed:", err instanceof Error ? err.message : "unknown");
          res.status(500).json({ status: "scatter_failed", error: "scatterDirect failed" });
        }
        return;
      }

      // Add to orderbook
      const stored = orderbook.add(order);

      // Post summary to shared orderbook (fire-and-forget)
      if (sharedClient) {
        sharedClient.postOrder({
          nonce: order.nonce.toString(),
          pubKeyAx: order.pubKeyAx.toString(),
          sellToken: "0x" + order.sellToken.toString(16).padStart(40, "0"),
          buyToken: "0x" + order.buyToken.toString(16).padStart(40, "0"),
          sellAmount: order.sellAmount.toString(),
          buyAmount: order.buyAmount.toString(),
          minFillAmount: order.buyAmount.toString(),
          maxFee: Number(order.maxFee),
          expiry: Number(order.expiry),
        }).then((id) => {
          if (id && orderIdMap) {
            orderIdMap.set(`${order.pubKeyAx}:${order.nonce}`, id);
          }
        }).catch((err) => {
          console.warn("[shared-orderbook] Failed to post order:", err instanceof Error ? err.message : "unknown");
        });
      }

      // Try to find a match (local first, then remote)
      const matchResult = matcher.findMatchIncludingRemote(stored);
      if (matchResult) {
        if (isCrossRelayerMatch(matchResult)) {
          // Cross-relayer match → send Trade Offer to maker's relayer
          // If no crossRelayerService, skip silently (local-only mode)
          if (!crossRelayerService) {
            res.json({ status: "pending", nonce: order.nonce.toString() });
            return;
          }
          // Lock local order before awaiting remote settlement (prevents double-matching)
          stored.status = "matched";
          orderbook.persistStatus(order.pubKeyAx, order.nonce, "matched");
          try {
            const tradeResult = await crossRelayerService.sendTradeOffer(
              matchResult.localOrder,
              matchResult.remoteOrder,
            );
            if (tradeResult.status === "settled" && tradeResult.txHash) {
              stored.status = "settled";
              stored.settleTxHash = tradeResult.txHash;
              stored.crossRelayer = true;
              orderbook.remove(order);
              orderbook.persistStatus(order.pubKeyAx, order.nonce, "settled", tradeResult.txHash, true);
              // Cancel settled order from shared orderbook
              if (sharedClient && orderIdMap) {
                const key = `${order.pubKeyAx}:${order.nonce}`;
                const oid = orderIdMap.get(key);
                if (oid) { sharedClient.cancelOrder(oid).catch(() => {}); orderIdMap.delete(key); }
              }
              res.json({ status: "settled", txHash: tradeResult.txHash, crossRelayer: true });
              return;
            }
            // Trade offer rejected — restore to pending
            console.warn("[cross-relayer] Trade offer rejected:", tradeResult.reason);
          } catch (err) {
            console.warn("[cross-relayer] Trade offer failed:", err instanceof Error ? err.message : "unknown");
          }
          // Restore to pending if not settled
          if (stored.status === "matched") {
            stored.status = "pending";
            orderbook.persistStatus(order.pubKeyAx, order.nonce, "pending");
          }
        } else {
          // Local match — existing settlement flow
          const match = matchResult;
          match.maker.status = "matched";
          match.taker.status = "matched";
          orderbook.remove(match.maker.order);
          orderbook.remove(match.taker.order);
          orderbook.persistStatus(match.maker.order.pubKeyAx, match.maker.order.nonce, "matched");
          orderbook.persistStatus(match.taker.order.pubKeyAx, match.taker.order.nonce, "matched");

          try {
            const txHash = await submitter.submitPrivateSettle(match);
            match.maker.status = "settled";
            match.maker.settleTxHash = txHash;
            match.taker.status = "settled";
            match.taker.settleTxHash = txHash;
            orderbook.persistStatus(match.maker.order.pubKeyAx, match.maker.order.nonce, "settled", txHash);
            orderbook.persistStatus(match.taker.order.pubKeyAx, match.taker.order.nonce, "settled", txHash);

            // Cancel settled orders from shared orderbook
            if (sharedClient && orderIdMap) {
              for (const m of [match.maker, match.taker]) {
                const key = `${m.order.pubKeyAx}:${m.order.nonce}`;
                const oid = orderIdMap.get(key);
                if (oid) { sharedClient.cancelOrder(oid).catch(() => {}); orderIdMap.delete(key); }
              }
            }

            res.json({ status: "settled", txHash });
            return;
          } catch (err: unknown) {
            orderbook.persistStatus(match.maker.order.pubKeyAx, match.maker.order.nonce, "pending");
            orderbook.persistStatus(match.taker.order.pubKeyAx, match.taker.order.nonce, "pending");
            match.maker.status = "pending";
            match.taker.status = "pending";
            try {
              orderbook.add(match.maker.order);
              orderbook.add(match.taker.order);
            } catch (readdErr) {
              console.error("failed to re-add orders to memory (DB safe):", readdErr);
            }
            console.error("private settle failed:", err instanceof Error ? err.message : "unknown");
            res.status(500).json({ status: "settle_failed", error: "private settlement failed" });
            return;
          }
        }
      }

      res.json({ status: "pending", nonce: order.nonce.toString() });
    } catch (err: any) {
      console.error("Order submission failed:", err.message || err);
      // Filter error messages — don't expose internal details
      const msg = err.message || "";
      const safeErrors = ["invalid eddsa signature", "expired", "fee too low", "duplicate nonce", "missing"];
      const safe = safeErrors.find((s) => msg.toLowerCase().includes(s));
      res.status(400).json({ error: safe ? msg : "Order submission failed" });
    }
  });

  // GET /api/private-orders/:pubKeyAx
  if (readLimiter) router.get("/:pubKeyAx", readLimiter);
  router.get("/:pubKeyAx", (req: Request, res: Response) => {
    const { status, limit, offset } = req.query;
    let pubKeyAx: bigint;
    try {
      pubKeyAx = BigInt(req.params.pubKeyAx);
    } catch {
      res.status(400).json({ error: "invalid pubKeyAx" });
      return;
    }

    const hasQueryParams = status !== undefined || limit !== undefined || offset !== undefined;

    if (!hasQueryParams) {
      const orders = orderbook.getOrdersByPubKey(pubKeyAx);
      res.json(orders.map((o) => serializePrivateOrder(o)));
      return;
    }

    const validStatuses: PrivateOrderStatus[] = ["pending", "matched", "settled", "cancelled", "expired"];
    if (status !== undefined && !validStatuses.includes(status as PrivateOrderStatus)) {
      res.status(400).json({ error: `invalid status: must be one of ${validStatuses.join(", ")}` });
      return;
    }

    const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const parsedOffset = Math.max(Number(offset) || 0, 0);

    const orders = orderbook.getOrderHistory(pubKeyAx, {
      status: status as PrivateOrderStatus | undefined,
      limit: parsedLimit,
      offset: parsedOffset,
    });
    const total = orderbook.countOrders(pubKeyAx, status as PrivateOrderStatus | undefined);

    res.json({
      orders: orders.map((o) => serializePrivateOrder(o)),
      total,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  });

  // GET /api/private-orders/:pubKeyAx/:nonce
  if (readLimiter) router.get("/:pubKeyAx/:nonce", readLimiter);
  router.get("/:pubKeyAx/:nonce", (req: Request, res: Response) => {
    let pubKeyAx: bigint, nonce: bigint;
    try {
      pubKeyAx = BigInt(req.params.pubKeyAx);
      nonce = BigInt(req.params.nonce);
    } catch {
      res.status(400).json({ error: "invalid pubKeyAx or nonce" });
      return;
    }

    const stored = orderbook.getOrderByNonce(pubKeyAx, nonce);
    if (!stored) {
      res.status(404).json({ error: "order not found" });
      return;
    }

    res.json(serializePrivateOrder(stored));
  });

  // DELETE /api/private-orders/:pubKeyAx/:nonce
  router.delete("/:pubKeyAx/:nonce", async (req: Request, res: Response) => {
    let pubKeyAx: bigint, nonce: bigint;
    try {
      pubKeyAx = BigInt(req.params.pubKeyAx);
      nonce = BigInt(req.params.nonce);
    } catch {
      res.status(400).json({ error: "invalid pubKeyAx or nonce" });
      return;
    }

    // Verify EdDSA cancel signature
    const sigHeader = req.headers["x-cancel-signature"] as string;
    if (!sigHeader) {
      res.status(401).json({ error: "missing x-cancel-signature header" });
      return;
    }

    try {
      const sig = JSON.parse(sigHeader);
      const cancelMsg = await poseidonHash([pubKeyAx, nonce]);

      // Need pubKeyAy from the order
      const stored = orderbook.getOrderByNonce(pubKeyAx, nonce);
      if (!stored) {
        res.status(404).json({ error: "order not found or already processed" });
        return;
      }

      const valid = await verifyEdDSA(
        cancelMsg,
        [pubKeyAx, stored.order.pubKeyAy],
        { S: BigInt(sig.sigS), R8x: BigInt(sig.sigR8x), R8y: BigInt(sig.sigR8y) },
      );

      if (!valid) {
        res.status(403).json({ error: "invalid cancel signature" });
        return;
      }
    } catch {
      res.status(400).json({ error: "invalid cancel signature format" });
      return;
    }

    const cancelled = orderbook.cancel(pubKeyAx, nonce);
    if (cancelled) {
      // Notify shared orderbook of cancellation
      if (sharedClient && orderIdMap) {
        const key = `${pubKeyAx}:${nonce}`;
        const orderbookId = orderIdMap.get(key);
        if (orderbookId) {
          sharedClient.cancelOrder(orderbookId).catch(() => {});
          orderIdMap.delete(key);
        }
      }
      res.json({ status: "cancelled" });
    } else {
      res.status(404).json({ error: "order not found or already processed" });
    }
  });

  return router;
}
