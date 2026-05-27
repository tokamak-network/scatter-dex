/**
 * Prometheus `/metrics` exposition endpoint (gap-analysis #14).
 *
 * Exposes the same in-memory + DB stats served as JSON at /api/relayer/stats,
 * formatted for Prometheus / Grafana / Datadog scrapers. No labels except
 * per-token volume — operator-side scrapers usually want one timeseries per
 * relayer process, distinguished by their own scrape_config job label.
 */

import { Router, Request, Response } from "express";
import type { PrivateOrderDB } from "../core/db.js";
import { getMetrics } from "../core/metrics.js";
import { getAuthorizeOrderStats } from "./authorize-orders.js";
import { isPaused } from "./admin.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("metrics-prom");

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// Settled-volume aggregation runs `GROUP_CONCAT(sell_amount)` and
// sums the BigInts in JS — O(settled-row-count). At a typical 15 s
// Prometheus scrape cadence that adds up; cache the result for
// `VOLUME_CACHE_TTL_MS` so back-to-back scrapers (Prom + Datadog +
// ad-hoc curl) only pay it once. Same TTL bound for /api/relayer/stats
// would also benefit, but only the metrics path has a tight scrape
// loop, so the cache lives here.
const VOLUME_CACHE_TTL_MS = 10_000;

type Sample = { name: string; help: string; type: "gauge" | "counter"; value: number; labels?: Record<string, string> };

function fmt(samples: Sample[]): string {
  const grouped = new Map<string, Sample[]>();
  for (const s of samples) {
    const arr = grouped.get(s.name) ?? [];
    arr.push(s);
    grouped.set(s.name, arr);
  }
  const lines: string[] = [];
  for (const [name, group] of grouped) {
    lines.push(`# HELP ${name} ${group[0].help}`);
    lines.push(`# TYPE ${name} ${group[0].type}`);
    for (const s of group) {
      const labels = s.labels
        ? "{" + Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",") + "}"
        : "";
      lines.push(`${name}${labels} ${formatNumber(s.value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return v.toString();
}

export function createMetricsRoutes(db: PrivateOrderDB): Router {
  const router = Router();
  let volumeCache: { at: number; value: ReturnType<PrivateOrderDB["getSettledVolume"]> } | null = null;

  router.get("/", (_req: Request, res: Response) => {
    try {
      const m = getMetrics();
      const stats = db.getRelayerStats();
      const now = Date.now();
      if (!volumeCache || now - volumeCache.at > VOLUME_CACHE_TTL_MS) {
        volumeCache = { at: now, value: db.getSettledVolume() };
      }
      const volume = volumeCache.value;

      const { pending: pendingOrders } = getAuthorizeOrderStats();

      const uptimeSec = stats.uptimeSince
        ? Math.floor((Date.now() - stats.uptimeSince) / 1000)
        : 0;

      const samples: Sample[] = [
        { name: "relayer_up", help: "1 if the relayer process is responding.", type: "gauge", value: 1 },
        { name: "relayer_paused", help: "1 if new order submission is paused via admin API.", type: "gauge", value: isPaused() ? 1 : 0 },
        { name: "relayer_uptime_seconds", help: "Seconds since the relayer process started.", type: "gauge", value: uptimeSec },

        { name: "relayer_orders_total", help: "Total authorize orders ever received.", type: "counter", value: stats.totalOrders },
        { name: "relayer_orders_settled_total", help: "Total authorize orders that reached settled status.", type: "counter", value: stats.settledOrders },
        { name: "relayer_orders_pending", help: "Authorize orders currently in pending status (in-memory).", type: "gauge", value: pendingOrders },
        { name: "relayer_success_rate_percent", help: "Settled orders as a percentage of total (0–100).", type: "gauge", value: stats.successRate },

        { name: "relayer_cross_relayer_settled_total", help: "Total settlements where the counterparty came from a peer relayer.", type: "counter", value: stats.crossRelayerSettled },
        { name: "relayer_trade_offers_total", help: "Total cross-relayer trade offers seen (audit trail).", type: "counter", value: stats.totalTradeOffers },
        { name: "relayer_trade_offers_settled_total", help: "Trade offers that resulted in a settled trade.", type: "counter", value: stats.settledTradeOffers },

        { name: "relayer_settlements_total", help: "Settlements counted by the in-memory metrics collector since process start.", type: "counter", value: m.settlement.totalCount },
        { name: "relayer_settlements_per_minute", help: "Settlement throughput over the last 5 minutes.", type: "gauge", value: m.settlement.perMinute },
        { name: "relayer_orders_submitted_per_minute", help: "Order submission throughput over the last 5 minutes.", type: "gauge", value: m.orders.submittedPerMinute },
      ];

      const dbAvg = stats.avgSettleTimeMs;
      if (dbAvg !== null) {
        samples.push({ name: "relayer_settle_time_db_avg_ms", help: "Average settled-time in milliseconds across all settled rows in the DB.", type: "gauge", value: dbAvg });
      }

      const aggregates: Array<[suffix: string, label: string]> = [
        ["avg", "Average"],
        ["min", "Min"],
        ["max", "Max"],
        ["last", "Latest"],
      ];
      const pushAgg = (
        nameTpl: (s: string) => string,
        helpTpl: (label: string) => string,
        values: Record<string, number | null>,
      ) => {
        for (const [suffix, label] of aggregates) {
          const value = values[suffix];
          if (value === null || value === undefined) continue;
          samples.push({ name: nameTpl(suffix), help: helpTpl(label), type: "gauge", value });
        }
      };
      pushAgg(
        (s) => `relayer_settlement_duration_${s}_ms`,
        (l) => `${l} settlement duration (TX submit → receipt) in milliseconds, last ${m.sampleSize} samples.`,
        { avg: m.settlement.avgDurationMs, min: m.settlement.minDurationMs, max: m.settlement.maxDurationMs, last: m.settlement.lastDurationMs },
      );
      pushAgg(
        (s) => `relayer_settlement_gas_${s}_eth`,
        (l) => `${l} settlement gas cost in ETH, last ${m.sampleSize} samples.`,
        { avg: m.gas.avgCostEth, min: m.gas.minCostEth, max: m.gas.maxCostEth, last: m.gas.lastCostEth },
      );
      samples.push({
        name: "relayer_gas_spent_eth_total",
        help: "Cumulative gas spent on settlements since process start, in ETH.",
        type: "counter",
        value: m.gas.totalSpentEth,
      });

      // Per-token settled volume. Volume is wei (uint256) — Prometheus
      // values are float64, so very large totals lose precision past ~2^53.
      // For monitoring/alerting that's fine; for accounting use the JSON
      // /api/relayer/stats endpoint which preserves the BigInt as a string.
      //
      // Label semantics: `token` is whichever leg the underlying row
      // contributed — always the sell-leg for `scatterDirectAuth`,
      // and either leg for `settleAuth` (since #837 the buy leg is
      // unioned in too). The grouping is purely per-token, not
      // "sell-side": "this relayer settled X wei of TOKEN" is the
      // correct read.
      for (const v of volume) {
        samples.push({
          name: "relayer_settled_volume_wei",
          help: "Total settled volume in wei grouped by token (includes both legs of settleAuth rows + the sell leg of scatterDirectAuth rows). Float-precision; use /api/relayer/stats for exact values.",
          type: "counter",
          value: Number(v.totalVolume),
          labels: { token: v.sellToken.toLowerCase() },
        });
        samples.push({
          name: "relayer_settled_volume_count",
          help: "Settled order count grouped by token (counts a settleAuth row once per leg, scatterDirectAuth once on the sell leg).",
          type: "counter",
          value: v.count,
          labels: { token: v.sellToken.toLowerCase() },
        });
      }

      res.setHeader("Content-Type", CONTENT_TYPE);
      res.status(200).send(fmt(samples));
    } catch (err) {
      log.error("Failed to render metrics", { err: err instanceof Error ? err.message : String(err) });
      // Emit a parseable metric (not a Prometheus comment) so scrapers
      // and alerting rules can fire on a render failure rather than
      // silently treating the whole scrape as missing.
      const errorBody = fmt([{
        name: "relayer_metrics_render_error",
        help: "1 if the most recent /metrics render threw; 0 (or absent) on success.",
        type: "gauge",
        value: 1,
      }]);
      res.setHeader("Content-Type", CONTENT_TYPE);
      res.status(500).send(errorBody);
    }
  });

  return router;
}
