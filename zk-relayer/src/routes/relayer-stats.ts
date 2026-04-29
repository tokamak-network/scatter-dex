import { Router, RequestHandler } from "express";
import { clampLimit } from "@scatter-dex/types";
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
      const limit = clampLimit(req.query.limit, 200, 50);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const offers = db.getTradeOffers(limit, offset);
      res.json({ offers, count: offers.length, offset });
    } catch (err) {
      console.error("[relayer-stats] Failed to load trade offers:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Failed to load trade offers" });
    }
  });

  /**
   * GET /api/relayer/history — persisted settlement history.
   * Query params:
   *   ?limit=50&offset=0
   *   ?type=settleAuth|scatterDirectAuth
   *   ?status=confirmed|failed
   * Returns newest-first paginated rows + a total count for the
   * filter combination so dashboards can render proper paging.
   */
  router.get("/history", ...limiter, (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 200, 50);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const type = parseSettlementType(req.query.type);
      const status = parseSettlementStatus(req.query.status);
      const { rows, total } = db.getSettlementHistory({ limit, offset, type, status });
      res.json({ rows, total, limit, offset });
    } catch (err) {
      console.error(
        "[relayer-stats] Failed to load settlement history:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({ error: "Failed to load settlement history" });
    }
  });

  /**
   * GET /api/relayer/history/fees — fee accruals.
   * Default response is per-token totals (sums + counts) since the
   * dashboard primarily wants "how much have I made in token X".
   * Pass ?detail=1 to get individual fee rows instead.
   * Query params:
   *   ?token=0x…
   *   ?since=<unix-ms>
   *   ?detail=1 (rows mode only)
   *   ?limit=&offset= (rows mode only)
   */
  router.get("/history/fees", ...limiter, (req, res) => {
    try {
      const since = Number(req.query.since) || 0;
      // Lowercase the address here as well as in the DB layer so a
      // checksummed query string compares against the lowercase
      // storage form. Without this, the post-query filter on totals
      // would silently return empty.
      const token =
        typeof req.query.token === "string" ? req.query.token.toLowerCase() : undefined;
      if (req.query.detail === "1" || req.query.detail === "true") {
        const limit = clampLimit(req.query.limit, 500, 100);
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const rows = db.getFeeHistory({ limit, offset, since, token });
        res.json({ rows, count: rows.length, limit, offset });
        return;
      }
      const totals = db.getFeeTotals(since);
      const filtered = token ? totals.filter((t) => t.token === token) : totals;
      res.json({ totals: filtered });
    } catch (err) {
      console.error(
        "[relayer-stats] Failed to load fee history:",
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({ error: "Failed to load fee history" });
    }
  });

  return router;
}

const SETTLEMENT_TYPES = new Set(["settleAuth", "scatterDirectAuth"] as const);
const SETTLEMENT_STATUSES = new Set(["confirmed", "failed"] as const);

function parseSettlementType(v: unknown): "settleAuth" | "scatterDirectAuth" | undefined {
  if (typeof v !== "string") return undefined;
  return (SETTLEMENT_TYPES as Set<string>).has(v)
    ? (v as "settleAuth" | "scatterDirectAuth")
    : undefined;
}

function parseSettlementStatus(v: unknown): "confirmed" | "failed" | undefined {
  if (typeof v !== "string") return undefined;
  return (SETTLEMENT_STATUSES as Set<string>).has(v)
    ? (v as "confirmed" | "failed")
    : undefined;
}
