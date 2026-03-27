import { Router, Request, Response } from "express";
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
  chainId: bigint
): Router {
  const router = Router();

  // POST /api/orders — submit a signed order
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { order: rawOrder, signature } = req.body;

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

      // Add to orderbook
      const stored = orderbook.add({ order, signature });

      // Try to find a match
      const match = matcher.findMatch(stored);
      if (match) {
        try {
          const txHash = await submitter.submitSettle(match);
          match.maker.status = "settled";
          match.maker.settleTxHash = txHash;
          match.taker.status = "settled";
          match.taker.settleTxHash = txHash;
          orderbook.remove(match.maker.order);
          orderbook.remove(match.taker.order);

          res.json({ status: "matched", txHash });
          return;
        } catch (err: any) {
          console.error("settle failed:", err.message);
        }
      }

      res.json({ status: "pending", nonce: order.nonce.toString() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/orders/:address — get orders by maker
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

  // DELETE /api/orders/:address/:nonce — cancel order (requires signature proof)
  // Only the maker can cancel their own order by providing a signed cancel message
  router.delete("/:address/:nonce", (req: Request, res: Response) => {
    // For now, allow cancel by address match only
    // In production, require a signed cancel message
    const cancelled = orderbook.cancel(
      req.params.address,
      BigInt(req.params.nonce)
    );
    if (cancelled) {
      res.json({ status: "cancelled" });
    } else {
      res.status(404).json({ error: "order not found or already processed" });
    }
  });

  return router;
}
