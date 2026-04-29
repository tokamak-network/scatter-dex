/**
 * [R-7] Admin API — runtime relayer management endpoints.
 * All endpoints require x-admin-key header (timing-safe comparison).
 * See individual route handlers below for the full endpoint list.
 */

import { Router, Request, Response, RequestHandler } from "express";
import { adminAuth } from "../middleware/admin-auth.js";
import { config, updateRelayerFee } from "../config.js";
import { getSanctionedPubKeys, getSanctionedCount, addSanctionedPubKey, removeSanctionedPubKey } from "../core/sanctions-list.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import type { PrivateOrderDB } from "../core/db.js";
import { getProfile, updateProfile, validateProfile } from "../core/profile.js";
import { getRecentAlerts, isWebhookConfigured, sendAlert } from "../core/alerts.js";
import { getLastHealth } from "../core/health-monitor.js";
import { getLastBalance } from "../core/balance-monitor.js";
import { getSettlementFailureState } from "../core/settlement-failure-tracker.js";
import {
  createLogger,
  getRecentLogs,
  getLoggerConfig,
  type LogLevel,
} from "../core/logger.js";

const log = createLogger("admin");

let paused = false;

export function isPaused(): boolean {
  return paused;
}

export interface AdminRouteDeps {
  submitter: PrivateSubmitter;
  db: PrivateOrderDB;
  drainAuthorizeOrders: () => number;
  getAuthorizeOrderStats: () => { pending: number; matched: number; total: number };
  writeLimiter?: RequestHandler;
}

export function createAdminRoutes(deps: AdminRouteDeps): Router {
  const { submitter, db, drainAuthorizeOrders: drainAuthFn, getAuthorizeOrderStats: getAuthStatsFn, writeLimiter } = deps;

  // Restore pause state from DB on startup
  const savedPause = db.getMeta("paused");
  paused = savedPause === "true";
  if (paused) {
    log.info("Relayer is paused (restored from DB)");
  }

  const router = Router();
  const wl = writeLimiter ? [writeLimiter] : [];

  router.use(adminAuth);

  // GET /api/admin/status — relayer overview
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const wallet = submitter.getWallet();
      const ethBalancePromise = submitter.getProvider().getBalance(wallet.address);
      const stats = db.getRelayerStats();
      const authStats = getAuthStatsFn();
      const ethBalance = await ethBalancePromise;

      res.json({
        paused,
        relayerAddress: submitter.getAddress(),
        feeBps: config.relayerFee,
        ethBalance: ethBalance.toString(),
        maxGasPriceGwei: config.maxGasPriceGwei,
        // privateOrders path retired (tracker #29). authorize is the only live flow.
        authorizeOrders: authStats,
        stats: {
          totalOrders: stats.totalOrders,
          settledOrders: stats.settledOrders,
          successRate: stats.successRate,
          crossRelayerSettled: stats.crossRelayerSettled,
          avgSettleTimeMs: stats.avgSettleTimeMs,
          uptimeSince: stats.uptimeSince,
        },
        pendingTxs: db.getPendingTxs().length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      res.status(500).json({ error: `Failed to get status: ${msg}` });
    }
  });

  // GET /api/admin/balance — ETH balance details
  router.get("/balance", async (_req: Request, res: Response) => {
    try {
      const provider = submitter.getProvider();
      const wallet = submitter.getWallet();
      const [ethBalance, network] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getNetwork(),
      ]);

      res.json({
        address: wallet.address,
        ethBalance: ethBalance.toString(),
        chainId: Number(network.chainId),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown";
      res.status(500).json({ error: `Failed to get balance: ${msg}` });
    }
  });

  router.put("/fee", ...wl, (req: Request, res: Response) => {
    const { feeBps } = req.body;
    if (typeof feeBps !== "number" || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
      res.status(400).json({ error: "feeBps must be an integer between 0 and 10000" });
      return;
    }

    const oldFee = config.relayerFee;
    updateRelayerFee(feeBps);
    db.setMeta("relayerFee", feeBps.toString());

    log.info("Fee changed", { oldBps: oldFee, newBps: feeBps });
    res.json({ status: "updated", oldFeeBps: oldFee, newFeeBps: feeBps });
  });

  router.post("/pause", ...wl, (_req: Request, res: Response) => {
    if (paused) {
      res.status(409).json({ error: "Relayer is already paused" });
      return;
    }
    paused = true;
    db.setMeta("paused", "true");
    log.info("Relayer PAUSED — new orders will be rejected");
    res.json({ status: "paused" });
  });

  router.post("/resume", ...wl, (_req: Request, res: Response) => {
    if (!paused) {
      res.status(409).json({ error: "Relayer is not paused" });
      return;
    }
    paused = false;
    db.setMeta("paused", "false");
    log.info("Relayer RESUMED — accepting orders");
    res.json({ status: "resumed" });
  });

  router.post("/drain", ...wl, (_req: Request, res: Response) => {
    const authRemoved = drainAuthFn();
    log.info("Drained orders", { authorize: authRemoved });
    res.json({
      status: "drained",
      authorizeOrdersCancelled: authRemoved,
    });
  });

  // [R-10] GET /api/admin/sanctions — list sanctioned pubKeys
  router.get("/sanctions", (_req: Request, res: Response) => {
    res.json({ count: getSanctionedCount(), entries: getSanctionedPubKeys() });
  });

  // [R-10] POST /api/admin/sanctions — add pubKey(s) to sanctions list
  router.post("/sanctions", ...wl, (req: Request, res: Response) => {
    const entries = req.body?.entries as Array<{ pubKeyAx: string; pubKeyAy: string }> | undefined;
    if (!Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ error: "body.entries must be a non-empty array of { pubKeyAx, pubKeyAy }" });
      return;
    }
    // Validate all entries up-front (including BigInt parseability) so we
    // never partially succeed: reject 400 with the offending index if any
    // entry is malformed, rather than bubbling into a 500 via Express.
    const invalid: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (typeof e?.pubKeyAx !== "string" || typeof e?.pubKeyAy !== "string") {
        invalid.push(i);
        continue;
      }
      try { BigInt(e.pubKeyAx); BigInt(e.pubKeyAy); } catch { invalid.push(i); }
    }
    if (invalid.length > 0) {
      res.status(400).json({ error: "invalid pubKeyAx/pubKeyAy in body.entries", invalidIndices: invalid });
      return;
    }
    let added = 0;
    for (const e of entries) {
      if (addSanctionedPubKey(e.pubKeyAx, e.pubKeyAy)) added++;
    }
    log.info("Added sanctioned pubKeys", { added });
    res.json({ added });
  });

  // [R-10] DELETE /api/admin/sanctions — remove pubKey(s) from sanctions list
  router.delete("/sanctions", ...wl, (req: Request, res: Response) => {
    const entries = req.body?.entries as Array<{ pubKeyAx: string; pubKeyAy: string }> | undefined;
    if (!Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ error: "body.entries must be a non-empty array of { pubKeyAx, pubKeyAy }" });
      return;
    }
    const invalid: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (typeof e?.pubKeyAx !== "string" || typeof e?.pubKeyAy !== "string") {
        invalid.push(i);
        continue;
      }
      try { BigInt(e.pubKeyAx); BigInt(e.pubKeyAy); } catch { invalid.push(i); }
    }
    if (invalid.length > 0) {
      res.status(400).json({ error: "invalid pubKeyAx/pubKeyAy in body.entries", invalidIndices: invalid });
      return;
    }
    let removed = 0;
    for (const e of entries) {
      if (removeSanctionedPubKey(e.pubKeyAx, e.pubKeyAy)) removed++;
    }
    log.info("Removed sanctioned pubKeys", { removed });
    res.json({ removed });
  });

  // GET /api/admin/profile — read current operator-set profile.
  router.get("/profile", (_req: Request, res: Response) => {
    res.json(getProfile(db));
  });

  // PATCH /api/admin/profile — merge the provided fields onto the
  // existing profile. Empty-string fields clear; absent fields preserve.
  // Returns the merged profile on success.
  router.patch("/profile", ...wl, (req: Request, res: Response) => {
    try {
      const patch = validateProfile(req.body);
      const next = updateProfile(db, patch);
      log.info("Profile updated");
      res.json(next);
    } catch (e: unknown) {
      res.status(400).json({ error: e instanceof Error ? e.message : "invalid profile" });
    }
  });

  // Persisted settlement history. Mounted under /api/admin so this
  // (and the per-token fee accrual at /history/fees below) inherit
  // the x-admin-key gate — both expose operator-private revenue
  // information that other relayers shouldn't be able to scrape.
  // Query params: ?limit=50&offset=0&type=...&status=...
  router.get("/history", (req: Request, res: Response) => {
    try {
      const limit = clampHistoryLimit(req.query.limit);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const type = parseSettlementType(req.query.type);
      const status = parseSettlementStatus(req.query.status);
      const { rows, total } = db.getSettlementHistory({ limit, offset, type, status });
      res.json({ rows, total, limit, offset });
    } catch (err) {
      log.error("history failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load settlement history" });
    }
  });

  // GET /api/admin/history/by-tx/:txHash — single settlement + fees.
  // Returns 404 when the tx_hash isn't in settlement_history.
  router.get("/history/by-tx/:txHash", (req: Request, res: Response) => {
    try {
      const { txHash } = req.params;
      // Cheap shape check before going to the DB; tx hashes are
      // 32-byte hex (0x + 64 chars) and a malformed param almost
      // certainly came from a typo, not a real lookup.
      if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        res.status(400).json({ error: "txHash must be a 0x-prefixed 32-byte hex string" });
        return;
      }
      const found = db.getSettlementByTxHash(txHash);
      if (!found) {
        res.status(404).json({ error: "Settlement not found for that tx hash" });
        return;
      }
      res.json(found);
    } catch (err) {
      log.error("history/by-tx failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load settlement detail" });
    }
  });

  // GET /api/admin/history/buckets — time-bucketed performance data
  // for the SLA dashboard. Returns one entry per bucket with settled
  // / failed counts, average gas, and p50/p95/p99 latency over the
  // confirmed rows in that bucket. Buckets with no rows are emitted
  // as zeros so the client can render a continuous time series.
  // Query params:
  //   ?since=<unix-ms>     required; window start
  //   ?until=<unix-ms>     optional; defaults to now. Validated as a
  //                        finite positive ms timestamp >= since.
  //   ?bucketMs=<n>        bucket width in ms; default 1h. Floor 1m;
  //                        also clamped *upward* so numBuckets never
  //                        exceeds the DB layer's hard cap (1024).
  router.get("/history/buckets", (req: Request, res: Response) => {
    try {
      const since = Number(req.query.since);
      if (!Number.isFinite(since) || since <= 0) {
        res.status(400).json({ error: "since must be a positive unix-ms timestamp" });
        return;
      }
      let until: number;
      if (req.query.until === undefined) {
        until = Date.now();
      } else {
        const parsed = Number(req.query.until);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          res.status(400).json({ error: "until must be a positive unix-ms timestamp" });
          return;
        }
        until = parsed;
      }
      if (until < since) {
        res.status(400).json({ error: "until must be >= since" });
        return;
      }
      const requested = Number(req.query.bucketMs) || 3_600_000;
      // Floor at 1m and ceiling-clamp upward so numBuckets <= 1024;
      // the DB layer otherwise refuses and returns []. This way the
      // operator gets a coarser-than-asked but actionable response
      // instead of an empty one.
      const minPerCap = Math.ceil((until - since) / 1024);
      const bucketMs = Math.max(60_000, minPerCap, requested);
      const buckets = db.getSettlementBuckets({ since, until, bucketMs });
      res.json({ buckets, since, until, bucketMs });
    } catch (err) {
      log.error("history/buckets failed", {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      res.status(500).json({ error: "Failed to load settlement buckets" });
    }
  });

  // Per-token fee totals by default; pass ?detail=1 for raw rows.
  // Query params: ?token=0x…&since=<unix-ms>[&detail=1&limit=&offset=]
  router.get("/history/fees", (req: Request, res: Response) => {
    try {
      const since = Number(req.query.since) || 0;
      // Lowercase the address here as well as in the DB layer so a
      // checksummed query matches the lowercase storage form.
      const token =
        typeof req.query.token === "string" ? req.query.token.toLowerCase() : undefined;
      if (req.query.detail === "1" || req.query.detail === "true") {
        const limit = clampHistoryLimit(req.query.limit, 500, 100);
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const rows = db.getFeeHistory({ limit, offset, since, token });
        res.json({ rows, count: rows.length, limit, offset });
        return;
      }
      const totals = db.getFeeTotals(since);
      const filtered = token ? totals.filter((t) => t.token === token) : totals;
      res.json({ totals: filtered });
    } catch (err) {
      log.error("history/fees failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load fee history" });
    }
  });

  // GET /api/admin/webhook — recent alert deliveries + config state.
  // The URL itself is not echoed back; operators see whether one is
  // configured and the last 50 alerts that were attempted.
  router.get("/webhook", (_req: Request, res: Response) => {
    res.json({
      configured: isWebhookConfigured(),
      health: getLastHealth(),
      balance: getLastBalance(),
      settlementFailureStreak: getSettlementFailureState(),
      recent: getRecentAlerts(),
    });
  });

  // POST /api/admin/webhook/test — send a synthetic info alert so
  // the operator can verify the channel is reachable. Body is
  // optional; defaults are good enough for a smoke test.
  router.post("/webhook/test", ...wl, async (req: Request, res: Response) => {
    if (!isWebhookConfigured()) {
      res.status(409).json({ error: "WEBHOOK_URL is not configured" });
      return;
    }
    const customText =
      typeof req.body?.text === "string" ? req.body.text.slice(0, 256) : null;
    const delivery = await sendAlert({
      type: "test",
      severity: "info",
      text: customText ?? "Webhook test from /api/admin/webhook/test.",
      payload: { source: "admin-test", at: Date.now() },
    });
    res.json({ delivery });
  });

  // GET /api/admin/logs — bounded ring-buffer of recent structured
  // log records. Lets the operator console diagnose without SSH.
  // Query params:
  //   ?level=debug|info|warn|error  — minimum level to return
  //   ?mod=<module-name>             — exact module-name match
  //   ?since=<unix-ms>               — only records emitted >= this ts
  //   ?limit=<n>                     — cap returned rows. Logger
  //                                     internally clamps to
  //                                     min(bufferCap, hardQueryLimit)
  //                                     so a misconfigured cap can't
  //                                     materialise an unbounded list.
  router.get("/logs", (req: Request, res: Response) => {
    const cfg = getLoggerConfig();
    const level = parseLogLevel(req.query.level);
    const mod = typeof req.query.mod === "string" ? req.query.mod : undefined;
    const since = Number(req.query.since) || 0;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    const records = getRecentLogs({ level, mod, since, limit });
    res.json({ records, config: cfg });
  });

  // GET /api/admin/trade-offers — paginated cross-relayer audit
  // trail with optional filters. Same data as the public
  // /api/relayer/trade-offers but admin-gated so operator-private
  // peer associations / failure reasons aren't scrapeable by
  // unauthenticated callers.
  // Query params:
  //   ?direction=sent|received
  //   ?status=settled|rejected|error
  //   ?peer=0x…
  //   ?since=<unix-ms>
  //   ?limit=&offset=
  router.get("/trade-offers", (req: Request, res: Response) => {
    try {
      const limit = clampHistoryLimit(req.query.limit, 200, 50);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const direction = parseDirection(req.query.direction);
      const status =
        typeof req.query.status === "string" ? req.query.status : undefined;
      const peer =
        typeof req.query.peer === "string" ? req.query.peer : undefined;
      const since = Number(req.query.since) || 0;
      const rows = db.getTradeOffersFiltered({
        limit,
        offset,
        direction,
        status,
        peer,
        since,
      });
      res.json({ rows, count: rows.length, limit, offset });
    } catch (err) {
      log.error("trade-offers failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load trade offers" });
    }
  });

  // GET /api/admin/peer-stats — per-peer aggregate of cross-relayer
  // activity. `since` defaults to all-time; pass a unix-ms timestamp
  // to scope to a window.
  router.get("/peer-stats", (req: Request, res: Response) => {
    try {
      const since = Number(req.query.since) || 0;
      const peers = db.getPeerStats(since);
      res.json({ peers, since });
    } catch (err) {
      log.error("peer-stats failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load peer stats" });
    }
  });

  return router;
}

function parseDirection(v: unknown): "sent" | "received" | undefined {
  if (v === "sent" || v === "received") return v;
  return undefined;
}

function parseLogLevel(v: unknown): LogLevel | undefined {
  if (typeof v !== "string") return undefined;
  return (["debug", "info", "warn", "error"] as const).includes(v as LogLevel)
    ? (v as LogLevel)
    : undefined;
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

function clampHistoryLimit(raw: unknown, max = 200, fallback = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}
