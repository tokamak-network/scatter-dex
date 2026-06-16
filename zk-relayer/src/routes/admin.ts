/**
 * [R-7] Admin API — runtime relayer management endpoints.
 * All endpoints require x-admin-key header (timing-safe comparison).
 * See individual route handlers below for the full endpoint list.
 */

import { Router, Request, Response, RequestHandler } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { adminAuth, setSiweAuth } from "../middleware/admin-auth.js";
import { makeAdminSiweAuth } from "../core/admin-siwe.js";
import { config, updateRelayerFee } from "../config.js";
import { getSanctionedPubKeys, getSanctionedCount, addSanctionedPubKey, removeSanctionedPubKey } from "../core/sanctions-list.js";
import type { PrivateSubmitter } from "../core/private-submitter.js";
import { isWeiString, type PrivateOrderDB } from "../core/db.js";
import { decodeSettlementCalldata } from "../core/decode-settlement.js";
import { getProfile, updateProfile, validateProfile } from "../core/profile.js";
import { getRecentAlerts, isWebhookConfigured, sendAlert } from "../core/alerts.js";
import { getLastHealth } from "../core/health-monitor.js";
import { getLastBalance } from "../core/balance-monitor.js";
import { getClaimProbes } from "../core/claim-monitor.js";
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
  /** Required for the shared-OB backfill endpoint; absent when the
   *  relayer runs without an indexer (the endpoint then 503s). */
  backfillFromSharedOb?: (since?: number) => Promise<{
    scanned: number; inserted: number; skipped: number; errors: number; pages: number;
  }>;
}

export function createAdminRoutes(deps: AdminRouteDeps): Router {
  const { submitter, db, drainAuthorizeOrders: drainAuthFn, getAuthorizeOrderStats: getAuthStatsFn, writeLimiter, backfillFromSharedOb } = deps;

  // Restore pause state from DB on startup
  const savedPause = db.getMeta("paused");
  paused = savedPause === "true";
  if (paused) {
    log.info("Relayer is paused (restored from DB)");
  }

  const router = Router();
  const wl = writeLimiter ? [writeLimiter] : [];

  // Wallet-signature (SIWE) auth, bound to the node's operator. An operator
  // manages *their own* node, and the node already knows its operator
  // address (the `RELAYER_PRIVATE_KEY` wallet, == the address registered
  // on-chain for this relayer). So auth needs no external config: always
  // initialise SIWE and admit only that operator. (No `RELAYER_REGISTRY_ADDRESS`
  // dependency — that gate previously left unconfigured nodes returning 403.)
  const siwe = makeAdminSiweAuth(submitter.getAddress());
  setSiweAuth(siwe);

  // Public — no auth — operators need this to mint a challenge
  // they haven't yet signed for. Behind the writeLimiter even
  // though it's a GET: each call grows the in-memory nonce map
  // until its 60s TTL elapses, so an unauthenticated attacker
  // could otherwise spam to consume memory.
  router.get("/challenge", ...wl, (_req: Request, res: Response) => {
    // The SIWE module owns the canonical message format — issuing
    // the message here would risk client/server drift between this
    // route and `createSession`'s exact-match check.
    res.json(siwe.issueChallenge());
  });

  // Public — verifies the signature server-side and matches the recovered
  // signer against the operator address. Cap the writeLimiter so a
  // brute-forcer can't pin the process.
  router.post("/session", ...wl, async (req: Request, res: Response) => {
    const { nonce, message, signature } = req.body ?? {};
    if (
      typeof nonce !== "string" ||
      typeof message !== "string" ||
      typeof signature !== "string"
    ) {
      res.status(400).json({ error: "nonce, message, signature required (strings)" });
      return;
    }
    try {
      const { token, address, expiresAt } = await siwe.createSession({
        nonce,
        message,
        signature,
      });
      res.json({ token, address, expiresAt });
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : "Session creation failed",
      });
    }
  });

  // Authenticated — explicit logout. Idempotent. Mounted before the
  // global `adminAuth` so it can read the bearer token directly
  // from the header rather than going through the middleware twice.
  router.post("/session/revoke", (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      siwe.revokeSession(auth.slice("Bearer ".length).trim());
    }
    res.status(204).end();
  });

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
      // Attach per-tx fee aggregation so the dashboard's recent-
      // settlements list can show "what did this settle pay me"
      // without N+1'ing /history/by-tx for every row. Empty array
      // when no fee rows exist for the tx (older settle row or a
      // failed attempt).
      const feesByTx = rows.length > 0 ? db.getFeesByTxHashes(rows.map((r) => r.tx_hash)) : new Map();
      const enriched = rows.map((r) => ({
        ...r,
        fees: feesByTx.get(r.tx_hash) ?? [],
      }));
      res.json({ rows: enriched, total, limit, offset });
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

  // GET /api/admin/history.csv — Compliance/finance export of the
  // settlement_history table for a time window. Streamed via the DB
  // iterator so memory stays bounded for large windows.
  // Query params:
  //   ?since=<unix-ms>   optional; defaults to 0 (all time)
  //   ?until=<unix-ms>   optional; defaults to now
  //   ?type=, ?status=   same filters as /history
  router.get("/history.csv", async (req: Request, res: Response) => {
    const since = parseTimestamp(req.query.since, 0);
    const until = parseTimestamp(req.query.until, Date.now());
    if (until < since) {
      res.status(400).json({ error: "until must be >= since" });
      return;
    }
    const type = parseSettlementType(req.query.type);
    const status = parseSettlementStatus(req.query.status);

    const filename = `settlements-${new Date(since).toISOString().slice(0, 10)}-to-${new Date(until).toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Wrap the row iterator in a Readable so `pipeline()` honours
    // backpressure on slow clients — without this, large exports
    // accumulate in Node's socket buffer regardless of consumer speed.
    function* csvLines(): Iterable<string> {
      // UTF-8 BOM so Windows Excel detects the encoding for non-ASCII
      // cells (e.g. error_reason text from upstream RPC errors).
      yield "﻿" + SETTLEMENT_CSV_HEADER + "\n";
      for (const row of db.iterateSettlementHistoryRange({ since, until, type, status })) {
        yield settlementRowToCsv(row);
      }
    }
    try {
      await pipeline(Readable.from(csvLines(), { encoding: "utf8" }), res);
    } catch (err) {
      log.error("history.csv failed", { err: err instanceof Error ? err.message : String(err) });
      // Mid-stream: headers are already flushed, so destroying the
      // socket surfaces as a network error on the client rather than
      // a clean EOF on a truncated file. Pre-stream errors won't reach
      // here — pipeline() would have rejected before any header flush.
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to export settlement history" });
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  // GET /api/admin/orders/by-tx/:txHash/proof — decode a settlement
  // tx's calldata into its public signals (the proof itself stays
  // off-chain — this is the on-chain tuple the verifier asserts).
  // When a settlement reverts, the operator can compare these fields
  // against `last_error` to debug nullifier/commitment issues.
  // GET /api/admin/authorize-orders/:nullifier — operator-only
  // detail for one authorize order. Mirrors the public
  // /api/authorize-orders/:nullifier reply but also exposes the
  // EdDSA pubKey columns from the row, which the public route
  // deliberately omits (they'd leak the trader identifier to any
  // peer). Used by the operator drawer's Sender section for orders
  // that didn't settle (cancelled / expired) — the history/by-tx
  // path doesn't cover those because there's no settlement row to
  // join the authorize-side processing against.
  router.get("/authorize-orders/:nullifier", (req: Request, res: Response) => {
    try {
      const { nullifier } = req.params;
      if (typeof nullifier !== "string" || nullifier.length === 0) {
        res.status(400).json({ error: "nullifier required" });
        return;
      }
      const row = db.getAuthorizeOrder(nullifier);
      if (!row) {
        res.status(404).json({ error: "authorize order not found" });
        return;
      }
      // The raw orderJson column carries the exact body the trader
      // POSTed (proof + publicSignals + pubKey). Parse it back to
      // an object so the operator drawer's Show technical can dump
      // it nicely — falling back to the raw string when JSON.parse
      // fails so a corrupt blob still surfaces (operator can debug
      // from the string form).
      let parsedOrder: unknown = row.orderJson;
      if (typeof row.orderJson === "string") {
        try {
          parsedOrder = JSON.parse(row.orderJson);
        } catch {
          parsedOrder = row.orderJson;
        }
      }
      res.json({
        nullifier: row.nullifier,
        status: row.status,
        submittedAt: row.submittedAt,
        updatedAt: row.updatedAt,
        attempt: row.attempt,
        settleTx: row.settleTx ?? null,
        lastError: row.lastError ?? null,
        pubKeyAx: row.pubKeyAx ?? null,
        pubKeyAy: row.pubKeyAy ?? null,
        order: parsedOrder,
      });
    } catch (err) {
      log.error("authorize-orders detail failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load authorize order" });
    }
  });

  router.get("/orders/by-tx/:txHash/proof", async (req: Request, res: Response) => {
    try {
      const { txHash } = req.params;
      if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        res.status(400).json({ error: "txHash must be a 0x-prefixed 32-byte hex string" });
        return;
      }
      const tx = await submitter.getProvider().getTransaction(txHash);
      if (!tx) {
        res.status(404).json({ error: "Transaction not found on-chain" });
        return;
      }
      const decoded = decodeSettlementCalldata(tx.data);
      res.json({
        txHash,
        from: tx.from,
        to: tx.to,
        blockNumber: tx.blockNumber,
        calldata: tx.data,
        decoded,
      });
    } catch (err) {
      log.error("orders/by-tx/proof failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to decode settlement proof" });
    }
  });

  // GET /api/admin/claims/by-tx/:txHash — claimed recipients for a
  // settled order. Decodes the settle calldata to recover the
  // claimsRoot(s) bound at settle time, then queryFilters every
  // PrivateClaim event keyed on those roots. Each emitted claim
  // reveals one recipient + token + amount, so the operator's
  // drawer can render a recipients table covering "everyone who has
  // already claimed against this settle." Unclaimed recipients
  // stay invisible (privacy by design — their leaf has never been
  // spent on chain).
  router.get("/claims/by-tx/:txHash", async (req: Request, res: Response) => {
    try {
      const { txHash } = req.params;
      if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        res.status(400).json({ error: "txHash must be a 0x-prefixed 32-byte hex string" });
        return;
      }
      const provider = submitter.getProvider();
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        res.status(404).json({ error: "Transaction not found on-chain" });
        return;
      }
      const decoded = decodeSettlementCalldata(tx.data);
      if (!decoded) {
        res.status(400).json({ error: "settle calldata not decodable (unknown selector)" });
        return;
      }
      // settleAuth carries maker + taker claimsRoots; scatterDirect /
      // cancel carry one. Build the de-duplicated set so a settleAuth
      // doesn't double-scan the same root.
      const roots = new Set<string>();
      if ("maker" in decoded && "taker" in decoded) {
        roots.add(decoded.maker.claimsRoot);
        roots.add(decoded.taker.claimsRoot);
      } else if ("proof" in decoded) {
        roots.add(decoded.proof.claimsRoot);
      }
      const settlementAddr = config.privateSettlementAddress;
      // PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed
      // nullifier, address indexed recipient, address token,
      // uint256 amount). Filter by claimsRoot only — recipient is
      // the unknown the caller wants to learn.
      const iface = new (await import("ethers")).ethers.Interface([
        "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
      ]);
      const contract = new (await import("ethers")).ethers.Contract(
        settlementAddr,
        iface,
        provider,
      );
      // Scan from genesis on local anvil; for a long-running chain
      // this would need a `fromBlock` hint, but for the local dev
      // anvil + small histories the cost is bounded.
      const claims: Array<{
        claimsRoot: string;
        nullifier: string;
        recipient: string;
        token: string;
        amount: string;
        blockNumber: number;
        txHash: string;
      }> = [];
      for (const root of roots) {
        try {
          const events = await contract.queryFilter(
            contract.filters.PrivateClaim(root),
            0,
            "latest",
          );
          for (const e of events) {
            const args = (e as { args?: { claimsRoot?: string; nullifier?: string; recipient?: string; token?: string; amount?: bigint } }).args;
            if (!args) continue;
            claims.push({
              claimsRoot: String(args.claimsRoot ?? root),
              nullifier: String(args.nullifier ?? ""),
              recipient: String(args.recipient ?? ""),
              token: String(args.token ?? ""),
              amount: (args.amount ?? 0n).toString(),
              blockNumber: e.blockNumber,
              txHash: e.transactionHash,
            });
          }
        } catch (err) {
          log.warn("PrivateClaim queryFilter failed for root", {
            root,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      res.json({
        txHash,
        roots: [...roots],
        claims,
      });
    } catch (err) {
      log.error("claims/by-tx failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load claims" });
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
  // Query params:
  //   ?token=0x…&since=<unix-ms>      filter (always honored)
  //   ?until=<unix-ms>                totals-only upper bound; ignored
  //                                   in detail mode, which is
  //                                   paginated by limit/offset and
  //                                   would need a separate prepared
  //                                   variant to bound on the upper end.
  //   ?detail=1&limit=&offset=        switch to raw fee_history rows
  router.get("/history/fees", (req: Request, res: Response) => {
    try {
      const since = Number(req.query.since) || 0;
      // `until=0` (default) means "no upper bound" — the analytics
      // page passes an explicit upper bound so a fixed period (today,
      // this week) reports the same total on every refresh instead of
      // sliding forward with Date.now().
      const until = Number(req.query.until) || 0;
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
      const totals = db.getFeeTotals(since, until);
      const filtered = token ? totals.filter((t) => t.token === token) : totals;
      res.json({ totals: filtered });
    } catch (err) {
      log.error("history/fees failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load fee history" });
    }
  });

  // Per-token notional totals from confirmed settlements in a window.
  // Powers the operators /analytics throughput cards alongside the
  // fee endpoint above — fees answer "what did we earn", volume
  // answers "what did we route". Same since/until convention.
  //   ?since=<unix-ms>[&until=<unix-ms>&token=0x…]
  router.get("/history/volume", (req: Request, res: Response) => {
    try {
      const since = Number(req.query.since) || 0;
      const until = Number(req.query.until) || 0;
      const token =
        typeof req.query.token === "string" ? req.query.token.toLowerCase() : undefined;
      const totals = db.getVolumeTotals(since, until);
      const filtered = token ? totals.filter((t) => t.token === token) : totals;
      res.json({ totals: filtered });
    } catch (err) {
      log.error("history/volume failed", { err: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to load volume history" });
    }
  });

  // One-shot reconciliation: pulls settlement rows from shared-OB
  // that this relayer participated in but doesn't have locally and
  // reinserts them into settlement_history + fee_history. Used to
  // recover analytics after a local DB reset — the push-outbox
  // covers the opposite direction (local → shared-OB) only.
  //
  //   POST /api/admin/push-outbox/backfill-from-shared-ob
  //   body: { "since"?: <unix-ms> }  // omit to scan from epoch
  router.post(
    "/push-outbox/backfill-from-shared-ob",
    ...wl,
    async (req: Request, res: Response) => {
      if (!backfillFromSharedOb) {
        res.status(503).json({ error: "shared-OB indexer not configured" });
        return;
      }
      // `since` is unix-ms (to match every other admin endpoint) —
      // the backfill module converts to seconds internally before
      // calling shared-OB. Reject non-finite / negative values up
      // front so a typo returns 400 instead of a silent no-op.
      let since: number | undefined;
      if (req.body && req.body.since !== undefined && req.body.since !== null) {
        const raw = req.body.since;
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
          res.status(400).json({
            error: "'since' must be a non-negative finite number (unix-ms)",
          });
          return;
        }
        since = raw;
      }
      try {
        const result = await backfillFromSharedOb(since);
        res.json(result);
      } catch (err) {
        log.error("backfill-from-shared-ob failed", {
          err: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({
          error: err instanceof Error ? err.message : "Backfill failed",
        });
      }
    },
  );

  // Settlement push-outbox stats — surfaces how many local settlements
  // are still awaiting shared-OB acknowledgement, so the operator can
  // detect a stuck push pipeline without tailing logs.
  router.get("/push-outbox/stats", (_req: Request, res: Response) => {
    try {
      res.json(db.getSettlementPushOutboxStats());
    } catch (err) {
      log.error("push-outbox/stats failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to read outbox stats" });
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
      const total = db.countTradeOffers({ direction, status, peer, since });
      // `count` is the page size (kept for back-compat), `total` is
      // the full filter-match count so paginated UIs can render an
      // accurate "page X of N".
      res.json({ rows, count: rows.length, total, limit, offset });
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

  // GET /api/admin/claim-thresholds — per-token claim-reminder
  // configuration plus the latest probe state from the claim
  // monitor. `tokens` reflects FEE_CLAIM_TOKENS (env-pinned), so
  // the UI can render rows even before any threshold is set.
  router.get("/claim-thresholds", (_req: Request, res: Response) => {
    res.json({
      tokens: config.feeClaimTokens,
      thresholds: db.getClaimThresholds(),
      probes: getClaimProbes(),
    });
  });

  // PUT /api/admin/claim-thresholds — replace the per-token
  // threshold map. Body: `{ thresholds: { [tokenAddr]: weiString } }`.
  // Wei is enforced as a positive-decimal-integer string (no
  // floats, no BigInt round-trip risk). Tokens not in
  // FEE_CLAIM_TOKENS are silently dropped — the env-pinned list
  // is the source of truth for what the monitor actually probes.
  router.put("/claim-thresholds", ...wl, (req: Request, res: Response) => {
    const body = req.body as { thresholds?: unknown };
    if (
      !body.thresholds ||
      typeof body.thresholds !== "object" ||
      Array.isArray(body.thresholds)
    ) {
      res
        .status(400)
        .json({ error: "thresholds must be an object of { token: weiString }" });
      return;
    }
    const allowed = new Set(config.feeClaimTokens.map((t) => t.toLowerCase()));
    const accepted: Record<string, string> = {};
    for (const [token, wei] of Object.entries(
      body.thresholds as Record<string, unknown>,
    )) {
      const tokenLc = token.toLowerCase();
      if (!allowed.has(tokenLc)) continue;
      if (!isWeiString(wei)) {
        res
          .status(400)
          .json({ error: `wei value for ${token} must be a non-negative decimal string` });
        return;
      }
      accepted[tokenLc] = wei;
    }
    db.setClaimThresholds(accepted);
    // `accepted` is already in the canonical lowercase/wei-string
    // shape that `getClaimThresholds` would return — echoing it
    // skips an unnecessary getMeta + JSON.parse round-trip.
    res.json({ thresholds: accepted });
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

function parseTimestamp(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function csvEscape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Single source of truth for the CSV column order — header line and
// per-row mapping are both derived from this so they cannot drift.
type SettlementCsvCol = {
  name: string;
  get: (row: import("../core/db.js").SettlementHistoryRow) => string | number | null;
};
const SETTLEMENT_CSV_COLUMNS: readonly SettlementCsvCol[] = [
  { name: "id", get: (r) => r.id },
  { name: "tx_hash", get: (r) => r.tx_hash },
  { name: "type", get: (r) => r.type },
  { name: "status", get: (r) => r.status },
  { name: "block_number", get: (r) => r.block_number },
  { name: "gas_cost_eth", get: (r) => r.gas_cost_eth },
  { name: "sell_token", get: (r) => r.sell_token },
  { name: "buy_token", get: (r) => r.buy_token },
  { name: "error_reason", get: (r) => r.error_reason },
  { name: "duration_ms", get: (r) => r.duration_ms },
  { name: "created_at", get: (r) => r.created_at },
  { name: "created_at_iso", get: (r) => new Date(r.created_at).toISOString() },
];
const SETTLEMENT_CSV_HEADER = SETTLEMENT_CSV_COLUMNS.map((c) => c.name).join(",");

function settlementRowToCsv(row: import("../core/db.js").SettlementHistoryRow): string {
  return SETTLEMENT_CSV_COLUMNS.map((c) => csvEscape(c.get(row))).join(",") + "\n";
}
