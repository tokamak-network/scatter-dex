import { Router, RequestHandler } from "express";
import { clampLimit } from "@scatter-dex/types";
import type { PrivateOrderDB } from "../core/db.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { getMetrics } from "../core/metrics.js";
import { authorizeOrders } from "./authorize-orders.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("relayer-stats");

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
      // Per-token lifetime fee revenue (since = 0). Exposed publicly
      // so the leaderboard can rank "who earned the most" without
      // each visitor needing peer admin auth. Settled volume already
      // ships through the same endpoint — fees are no more sensitive
      // than that, and operators routinely benchmark against each other.
      const feeTotals = db.getFeeTotals(0);
      res.json({
        address: submitter.getAddress(),
        ...stats,
        pendingOrders,
        settledVolume: volume,
        feeTotals,
        metrics: getMetrics(),
      });
    } catch (err) {
      log.error("Failed to load stats", {
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  /**
   * GET /api/relayer/trade-offers — Cross-relayer Trade Offer audit trail
   * Query params: ?limit=50&offset=0
   */
  router.get("/trade-offers", ...limiter, (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 200, 50);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const offers = db.getTradeOffers(limit, offset);
      res.json({ offers, count: offers.length, offset });
    } catch (err) {
      log.error("Failed to load trade offers", {
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to load trade offers" });
    }
  });

  return router;
}
