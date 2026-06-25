import { Router, RequestHandler } from "express";
import { clampLimit } from "@scatter-dex/types";
import type { PrivateOrderDB, TradeOfferRow } from "../core/db.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { getMetrics } from "../core/metrics.js";
import { authorizeOrders } from "./authorize-orders.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("relayer-stats");

/** Non-identifying view of a Trade Offer for the UNAUTHENTICATED public
 *  audit trail. */
interface PublicTradeOffer {
  direction: "sent" | "received";
  status: string;
  txHash: string | null;
  createdAt: number;
}

/**
 * Project a Trade Offer row down to its non-identifying fields.
 *
 * The full `TradeOfferRow` carries trader EdDSA pubkeys
 * (`maker_pub_key` / `taker_pub_key`), nonces, the counterparty relayer
 * (`peer_relayer`), and failure `reason`s — operator-private identifiers
 * that de-anonymize traders if scraped from the public endpoint. The
 * SIWE-gated admin route (`/api/admin/trade-offers`) returns the full
 * row; this public endpoint must expose only non-identifying fields.
 *
 * Allowlist (explicit pick), NOT omit — a future sensitive column added
 * to `TradeOfferRow` then can't silently leak through here.
 */
function toPublicTradeOffer(r: TradeOfferRow): PublicTradeOffer {
  return {
    direction: r.direction,
    status: r.status,
    txHash: r.tx_hash,
    createdAt: r.created_at,
  };
}

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
      // Per-app (Pay / Pro) split — sourced from the same
      // settlement_history rows, just GROUP BY type. Exposed publicly
      // for the operators leaderboard's segmented [All / Pay / Pro]
      // view; older relayers (no `byApp`) degrade to the aggregate.
      const byApp = db.getStatsByApp();
      res.json({
        address: submitter.getAddress(),
        ...stats,
        pendingOrders,
        settledVolume: volume,
        feeTotals,
        byApp,
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
      const offers = db.getTradeOffers(limit, offset).map(toPublicTradeOffer);
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
