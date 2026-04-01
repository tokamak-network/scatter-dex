import { Router, Request, Response, RequestHandler } from "express";
import { ethers } from "ethers";
import { Orderbook } from "../core/orderbook.js";
import { Matcher } from "../core/matcher.js";
import { Submitter } from "../core/submitter.js";
import { isValidSignature } from "../core/signer.js";
import { parseOrder } from "../types/order.js";
import { config } from "../config.js";

export function createOrderRoutes(
  orderbook: Orderbook,
  matcher: Matcher,
  submitter: Submitter,
  chainId: bigint,
  writeLimiter?: RequestHandler,
  readLimiter?: RequestHandler,
): Router {
  const router = Router();

  // POST /api/orders — submit a signed order (write rate limit)
  if (writeLimiter) router.post("/", writeLimiter);
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { order: rawOrder, signature, feeMode } = req.body;

      if (!rawOrder || !signature) {
        res.status(400).json({ error: "missing order or signature" });
        return;
      }

      // Parse string amounts to BigInt
      const order = parseOrder(rawOrder);

      // Verify signature
      if (!isValidSignature(order, signature, chainId, config.settlementAddress)) {
        res.status(400).json({ error: "invalid signature" });
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

      // Same-token order: scheduled transfer — settle immediately, no matching needed
      if (order.sellToken.toLowerCase() === order.buyToken.toLowerCase()) {
        try {
          const txHash = await submitter.submitScheduledTransfer({ order, signature, feeMode });
          orderbook.persistOrder({ order, signature }, "settled", feeMode === "cover_taker" ? "cover_taker" : undefined, txHash);

          res.json({ status: "settled", txHash });
          return;
        } catch (err: unknown) {
          console.error("scheduled transfer failed:", err instanceof Error ? err.message : "unknown");
          res.status(500).json({ status: "settle_failed", error: "scheduled transfer settlement failed" });
          return;
        }
      }

      // Add to orderbook (with feeMode so it's persisted to DB immediately)
      const stored = orderbook.add({ order, signature }, feeMode === "cover_taker" ? "cover_taker" : undefined);

      // Try to find a match
      const match = matcher.findMatch(stored);
      if (match) {
        // Immediately mark as matched and persist to DB to prevent
        // duplicate settlement attempts if the process crashes mid-settle
        match.maker.status = "matched";
        match.taker.status = "matched";
        orderbook.remove(match.maker.order);
        orderbook.remove(match.taker.order);
        orderbook.persistStatus(match.maker.order.maker, match.maker.order.nonce, "matched");
        orderbook.persistStatus(match.taker.order.maker, match.taker.order.nonce, "matched");

        try {
          const txHash = await submitter.submitSettle(match);
          match.maker.status = "settled";
          match.maker.settleTxHash = txHash;
          match.taker.status = "settled";
          match.taker.settleTxHash = txHash;
          orderbook.persistStatus(match.maker.order.maker, match.maker.order.nonce, "settled", txHash);
          orderbook.persistStatus(match.taker.order.maker, match.taker.order.nonce, "settled", txHash);

          res.json({ status: "matched", txHash });
          return;
        } catch (err: unknown) {
          // Settle failed — try to return orders to book
          match.maker.status = "pending";
          match.taker.status = "pending";
          try {
            orderbook.add({ order: match.maker.order, signature: match.maker.signature }, match.maker.feeMode);
            orderbook.add({ order: match.taker.order, signature: match.taker.signature }, match.taker.feeMode);
          } catch (readdErr) {
            console.error("failed to re-add orders after settle failure:", readdErr);
          }
          console.error("settle failed:", err instanceof Error ? err.message : "unknown");
          res.status(500).json({ status: "settle_failed", error: "settlement failed" });
          return;
        }
      }

      res.json({ status: "pending", nonce: order.nonce.toString() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/orders/:address — get orders by maker (read rate limit)
  if (readLimiter) router.get("/:address", readLimiter);
  router.get("/:address", (req: Request, res: Response) => {
    const orders = orderbook.getOrdersByMaker(req.params.address);
    res.json(
      orders.map((o) => ({
        maker: o.order.maker,
        sellToken: o.order.sellToken,
        buyToken: o.order.buyToken,
        sellAmount: o.order.sellAmount.toString(),
        buyAmount: o.order.buyAmount.toString(),
        nonce: o.order.nonce.toString(),
        status: o.status,
        submittedAt: o.submittedAt,
        settleTxHash: o.settleTxHash,
      }))
    );
  });

  // DELETE /api/orders/:address/:nonce — cancel order (read rate limit)
  // Requires `signature` header: signed message "cancel:<address>:<nonce>"
  router.delete("/:address/:nonce", (req: Request, res: Response) => {
    const { address, nonce } = req.params;
    const signature = req.headers["x-cancel-signature"] as string;

    if (!signature) {
      res.status(401).json({ error: "missing x-cancel-signature header" });
      return;
    }

    // Verify the cancel signature is from the order maker
    // Canonicalize nonce to prevent signature mismatch from different string representations
    let canonicalNonce: bigint;
    try {
      canonicalNonce = BigInt(nonce);
      if (canonicalNonce < 0n) {
        res.status(400).json({ error: "invalid nonce: must be non-negative" });
        return;
      }
    } catch {
      res.status(400).json({ error: "invalid nonce format" });
      return;
    }

    try {
      const message = `cancel:${address.toLowerCase()}:${canonicalNonce.toString()}`;
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        res.status(403).json({ error: "signature does not match order maker" });
        return;
      }
    } catch {
      res.status(400).json({ error: "invalid signature" });
      return;
    }

    const cancelled = orderbook.cancel(address, canonicalNonce);
    if (cancelled) {
      res.json({ status: "cancelled" });
    } else {
      res.status(404).json({ error: "order not found or already processed" });
    }
  });

  return router;
}
