import { Router, Request, Response, RequestHandler } from "express";
import type { PrivateOrderbook } from "../core/orderbook.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { parsePrivateOrder, serializePrivateOrder, type PrivateOrderStatus } from "../types/order.js";
import { poseidonHash, verifyEdDSA, computeClaimLeaf, buildMerkleTree } from "../core/zk-prover.js";
import { config } from "../config.js";
import type { SharedOrderbookClient } from "../core/shared-orderbook-client.js";

export function createPrivateOrderRoutes(
  orderbook: PrivateOrderbook,
  submitter: PrivateSubmitter,
  writeLimiter?: RequestHandler,
  readLimiter?: RequestHandler,
  sharedClient?: SharedOrderbookClient | null,
  orderIdMap?: Map<string, string>,
): Router {
  const router = Router();

  // [S-C1] POST /api/private-orders — DEPRECATED for P2P matching.
  // Only ScatterDirect (same-token redistribution) is still allowed here
  // because it requires witness data and has no authorize-path equivalent yet.
  // All other orders must use POST /api/authorize-orders (half-proof path).
  if (writeLimiter) router.post("/", writeLimiter);
  router.post("/", async (req: Request, res: Response) => {
    try {
      const order = parsePrivateOrder(req.body);

      // Only allow same-token (ScatterDirect) orders
      if (order.sellToken !== order.buyToken) {
        res.status(410).json({
          error: "P2P orders via this endpoint are deprecated for security reasons. Use POST /api/authorize-orders instead.",
          migration: "Generate an authorize proof locally and submit to /api/authorize-orders.",
        });
        return;
      }

      // Verify EdDSA signature
      const claimLeafHashes = await Promise.all(order.claims.map((c) => computeClaimLeaf(c)));
      const padded = [...claimLeafHashes];
      while (padded.length < 16) padded.push(0n);
      const { root: claimsRoot } = await buildMerkleTree(padded, 4);
      const relayerAddr = BigInt(submitter.getAddress());
      const msgHash = await poseidonHash([
        order.sellToken, order.buyToken, order.sellAmount, order.buyAmount,
        order.maxFee, order.expiry, order.nonce, claimsRoot, relayerAddr,
      ]);
      const valid = await verifyEdDSA(
        msgHash, [order.pubKeyAx, order.pubKeyAy],
        { S: order.sigS, R8x: order.sigR8x, R8y: order.sigR8y },
      );
      if (!valid) { res.status(400).json({ error: "invalid EdDSA signature" }); return; }

      const now = BigInt(Math.floor(Date.now() / 1000));
      if (order.expiry <= now) { res.status(400).json({ error: "order expired" }); return; }
      if (orderbook.hasNonce(order.pubKeyAx, order.nonce)) { res.status(400).json({ error: "duplicate nonce" }); return; }

      // ScatterDirect: same-token redistribution
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      const safeErrors = ["invalid eddsa signature", "expired", "duplicate nonce", "missing"];
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
