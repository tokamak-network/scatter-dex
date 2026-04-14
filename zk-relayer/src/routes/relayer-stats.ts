import { Router, RequestHandler } from "express";
import type { PrivateOrderDB } from "../core/db.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { getMetrics } from "../core/metrics.js";
import { authorizeOrders } from "./authorize-orders.js";

/**
 * Relayer stats & audit trail API.
 * Provides operator-facing endpoints for monitoring and trust building.
 */
export function createRelayerStatsRoutes(
  db: PrivateOrderDB,
  submitter: PrivateSubmitter,
  readLimiter?: RequestHandler,
): Router {
  const router = Router();
  const limiter = readLimiter ? [readLimiter] : [];

  /**
   * GET /api/relayer/stats — Relayer performance statistics
   */
  router.get("/stats", ...limiter, (_req, res) => {
    try {
      const stats = db.getRelayerStats();
      const volume = db.getSettledVolume();
      // Pending count switched from the retired private_orders Map (always 0
      // post-S-M14) to authorize_orders, the live half-proof flow.
      let pendingOrders = 0;
      for (const o of authorizeOrders.values()) {
        if (o.status === "pending") pendingOrders++;
      }
      res.json({
        address: submitter.getAddress(),
        ...stats,
        pendingOrders,
        settledVolume: volume,
        metrics: getMetrics(),
      });
    } catch (err) {
      console.error("[relayer-stats] Failed to load stats:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  /**
   * GET /api/relayer/trade-offers — Cross-relayer Trade Offer audit trail
   * Query params: ?limit=50&offset=0
   */
  router.get("/trade-offers", ...limiter, (req, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const offers = db.getTradeOffers(limit, offset);
      res.json({ offers, count: offers.length, offset });
    } catch (err) {
      console.error("[relayer-stats] Failed to load trade offers:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Failed to load trade offers" });
    }
  });

  return router;
}
