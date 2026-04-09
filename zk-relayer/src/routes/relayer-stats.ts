import { Router, RequestHandler } from "express";
import type { PrivateOrderDB } from "../core/db.js";
import type { PrivateOrderbook } from "../core/orderbook.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";

/**
 * Relayer stats & audit trail API.
 * Provides operator-facing endpoints for monitoring and trust building.
 */
export function createRelayerStatsRoutes(
  db: PrivateOrderDB,
  orderbook: PrivateOrderbook,
  submitter: PrivateSubmitter,
  readLimiter?: RequestHandler,
): Router {
  const router = Router();

  /**
   * GET /api/relayer/stats — Relayer performance statistics
   * Used by frontend relayer profile page and dashboard.
   */
  if (readLimiter) router.get("/stats", readLimiter);
  router.get("/stats", (_req, res) => {
    try {
      const stats = db.getRelayerStats();
      res.json({
        address: submitter.getAddress(),
        ...stats,
        pendingOrders: orderbook.pendingOrderCount,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  /**
   * GET /api/relayer/trade-offers — Cross-relayer Trade Offer audit trail
   * Query params: ?limit=50&offset=0
   */
  if (readLimiter) router.get("/trade-offers", readLimiter);
  router.get("/trade-offers", (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const offers = db.getTradeOffers(limit, offset);
      res.json({ offers, count: offers.length, offset });
    } catch (err) {
      res.status(500).json({ error: "Failed to load trade offers" });
    }
  });

  return router;
}
