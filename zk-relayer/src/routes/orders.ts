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

  // [S-C1] POST /api/private-orders — DEPRECATED (security: sends ownerSecret in plaintext)
  // Use POST /api/authorize-orders instead (half-proof path: user generates proof locally).
  // This endpoint is disabled to prevent accidental secret exposure.
  if (writeLimiter) router.post("/", writeLimiter);
  router.post("/", (_req: Request, res: Response) => {
    res.status(410).json({
      error: "This endpoint is deprecated for security reasons. Use POST /api/authorize-orders instead.",
      migration: "Generate an authorize proof locally and submit to /api/authorize-orders. See docs/circuit-split/design.md.",
    });
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
