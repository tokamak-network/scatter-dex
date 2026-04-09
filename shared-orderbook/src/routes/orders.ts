import { Router } from "express";
import type { RequestHandler } from "express";
import type { SharedOrderbook } from "../core/orderbook.js";
import type { OrderbookDB } from "../core/db.js";
import type { OrderBroadcaster } from "../core/broadcaster.js";
import { parseOrderSummary, pairKey, isValidPair } from "../types/order.js";
import { relayerAuth, type AuthenticatedRequest } from "../middleware/auth.js";

export function createOrderRoutes(
  orderbook: SharedOrderbook,
  db: OrderbookDB,
  broadcaster: OrderBroadcaster,
  writeLimiter: RequestHandler,
  readLimiter: RequestHandler,
): Router {
  const router = Router();

  /**
   * POST /api/orders — Post an order summary (listing)
   * Requires relayer authentication.
   */
  router.post("/", writeLimiter, relayerAuth, (req, res) => {
    try {
      const { relayerAddress, relayerUrl } = req as AuthenticatedRequest;

      if (!relayerUrl) {
        res.status(400).json({ error: "x-relayer-url header required for order posting" });
        return;
      }

      // Auto-register/heartbeat on order post
      orderbook.registerRelayer(relayerAddress, relayerUrl);

      const order = parseOrderSummary(req.body, relayerAddress, relayerUrl);

      // Duplicate check
      if (orderbook.getOrder(order.id)) {
        res.status(409).json({ error: "order already exists", id: order.id });
        return;
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

      let orders;
      if (pairRaw) {
        const tokens = isValidPair(pairRaw);
        if (!tokens) {
          res.status(400).json({ error: "invalid pair format" });
          return;
        }
        orders = db.listByPair(tokens[0], tokens[1], limit, offset);
      } else {
        orders = db.listOpen(limit, offset);
      }

      res.json({
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
  router.delete("/:id", writeLimiter, relayerAuth, (req, res) => {
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
