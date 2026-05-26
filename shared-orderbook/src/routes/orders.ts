import { Router } from "express";
import type { RequestHandler } from "express";
import type { SharedOrderbook } from "../core/orderbook.js";
import type { OrderbookDB } from "../core/db.js";
import type { OrderBroadcaster } from "../core/broadcaster.js";
import { parseOrderSummary, pairKey, isValidPair } from "../types/order.js";
import type { OrderStatus } from "@scatter-dex/types";
import { relayerAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertSafeOutboundUrl, UnsafeUrlError } from "../lib/url-guard.js";

export function createOrderRoutes(
  orderbook: SharedOrderbook,
  db: OrderbookDB,
  broadcaster: OrderBroadcaster,
  writeLimiter: RequestHandler,
  readLimiter: RequestHandler,
  relayerWriteLimiter?: RequestHandler,
): Router {
  const router = Router();

  /**
   * POST /api/orders — Post an order summary (listing)
   * Requires relayer authentication.
   */
  const postMiddleware: RequestHandler[] = [writeLimiter, relayerAuth];
  if (relayerWriteLimiter) postMiddleware.push(relayerWriteLimiter);
  router.post("/", ...postMiddleware, async (req, res) => {
    try {
      const { relayerAddress, relayerUrl } = req as AuthenticatedRequest;

      if (!relayerUrl) {
        res.status(400).json({ error: "x-relayer-url header required for order posting" });
        return;
      }

      // SSRF guard: every other relayer will fetch this URL when
      // matching. Reject private/loopback/link-local hosts before
      // letting the address into the in-memory registry. See
      // `lib/url-guard.ts` for the threat model.
      try {
        await assertSafeOutboundUrl(relayerUrl);
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          res.status(400).json({ error: `unsafe relayer URL: ${e.message}` });
          return;
        }
        throw e;
      }

      // Auto-register/heartbeat on order post
      orderbook.registerRelayer(relayerAddress, relayerUrl);

      const order = parseOrderSummary(req.body, relayerAddress, relayerUrl);

      // Dedup: only block when the existing row is still open. Terminal
      // rows (cancelled / expired / matched) shouldn't lock the id —
      // the offerHandle is derived from the funding nullifier in
      // zk-relayer/.../authorize-orders.ts:418, so a user reusing the
      // same commitment in a new order after cancel-on-chain naturally
      // produces the same id. Without this branch the second post is
      // rejected and the new order is invisible across relayers even
      // though it's perfectly valid on-chain.
      const existing = orderbook.getOrder(order.id);
      if (existing) {
        if (existing.status === "open") {
          res.status(409).json({ error: "order already exists", id: order.id });
          return;
        }
        // Replace the terminal row with the new submission. Drop the
        // SQL row first so the PRIMARY KEY on id doesn't reject the
        // insert below — the in-memory `addOrder` re-adds it cleanly.
        orderbook.removeOrder(order.id);
        db.deleteOrder(order.id);
      }

      const stored = orderbook.addOrder(order);
      db.insertOrder(order);

      // Broadcast to all connected relayers
      broadcaster.broadcast({ type: "order:new", order });

      res.status(201).json({ id: order.id, status: stored.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      res.status(400).json({ error: msg });
    }
  });

  /**
   * GET /api/orders — List open orders
   * Query params: ?pair=0xabc-0xdef&limit=100&offset=0
   */
  router.get("/", readLimiter, (req, res) => {
    try {
      const pairRaw = typeof req.query.pair === "string" ? req.query.pair : undefined;
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Number(req.query.offset) || 0;
      // status=all (default for legacy callers stays open) returns
      // every bucket; status=<one of OrderStatus> filters. Unknown
      // values fall back to the legacy open-only view rather than
      // 400ing, so an out-of-date client doesn't break.
      const statusRaw = typeof req.query.status === "string" ? req.query.status : "";
      const includeTerminal = statusRaw === "all";
      const statusFilter: OrderStatus | undefined =
        ["open", "cancelled", "expired", "matched"].includes(statusRaw)
          ? (statusRaw as OrderStatus)
          : undefined;

      let orders;
      if (pairRaw) {
        const tokens = isValidPair(pairRaw);
        if (!tokens) {
          res.status(400).json({ error: "invalid pair format" });
          return;
        }
        // Pair filter stays open-only for now — bucket tabs in the
        // UI are global; per-pair status drilldown is a follow-up.
        orders = db.listByPair(tokens[0], tokens[1], limit, offset);
      } else if (includeTerminal || statusFilter) {
        orders = db.listAll(limit, offset, statusFilter);
      } else {
        orders = db.listOpen(limit, offset);
      }

      // Include `status` on each row so the bucket-tab UI can filter
      // client-side without re-fetching, and surface a per-status
      // counts map so the tabs can render "All (12) · Open (5) · …"
      // numbers without a second round trip. Legacy callers that only
      // read `order.id` / `order.sellAmount` etc. ignore the extra
      // field cleanly.
      res.json({
        orders: orders.map((s) => ({ ...s.order, status: s.status })),
        count: orders.length,
        offset,
        counts: includeTerminal || statusFilter ? db.countByStatus() : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/orders/:pair — Orders for a specific token pair
   * :pair format: "0xabc...def-0x123...789" (sorted lowercase)
   */
  router.get("/:pair", readLimiter, (req, res) => {
    try {
      const tokens = isValidPair(req.params.pair);
      if (!tokens) {
        res.status(400).json({ error: "invalid pair format, use 0xTokenA-0xTokenB" });
        return;
      }

      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Number(req.query.offset) || 0;

      const orders = db.listByPair(tokens[0], tokens[1], limit, offset);
      res.json({
        pair: pairKey(tokens[0], tokens[1]),
        orders: orders.map(s => s.order),
        count: orders.length,
        offset,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      res.status(500).json({ error: msg });
    }
  });

  /**
   * DELETE /api/orders/:id — Cancel an order
   * Requires relayer authentication. Only the posting relayer can cancel.
   */
  const deleteMiddleware: RequestHandler[] = [writeLimiter, relayerAuth];
  if (relayerWriteLimiter) deleteMiddleware.push(relayerWriteLimiter);
  router.delete("/:id", ...deleteMiddleware, (req, res) => {
    try {
      const { relayerAddress } = req as AuthenticatedRequest;
      const { id } = req.params;

      const stored = orderbook.getOrder(id);
      if (!stored) {
        res.status(404).json({ error: "order not found" });
        return;
      }

      if (stored.order.relayer !== relayerAddress) {
        res.status(403).json({ error: "not your order" });
        return;
      }

      if (stored.status !== "open") {
        res.status(409).json({ error: `order is ${stored.status}, cannot cancel` });
        return;
      }

      orderbook.updateStatus(id, "cancelled");
      db.updateStatus(id, "cancelled");

      broadcaster.broadcast({
        type: "order:cancelled",
        orderId: id,
        relayer: relayerAddress,
      });

      res.json({ id, status: "cancelled" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
