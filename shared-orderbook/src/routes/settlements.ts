import { Router } from "express";
import type { RequestHandler } from "express";
import { clampLimit } from "@scatter-dex/types";
import type { OrderbookDB } from "../core/db.js";
import { parseSettlementInsert, LEADERBOARD_METRICS, type LeaderboardMetric } from "../types/settlement.js";
import { isValidPair } from "../types/order.js";
import { relayerAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { parseChainIdQuery, DEFAULT_CHAIN_ID } from "../core/chain.js";
import type { RelayerMembership } from "../core/relayer-membership.js";

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_LIMIT = 500;

function parseLimitOffset(q: Record<string, unknown>): { limit: number; offset: number } {
  const limit = clampLimit(q.limit, MAX_LIMIT, 100);
  const parsedOffset = q.offset === undefined ? 0 : Number(q.offset);
  const offset = Math.max(Number.isFinite(parsedOffset) ? parsedOffset : 0, 0);
  return { limit, offset };
}

/** Parse `?since=<unix-seconds>`. Returns the value, undefined when absent,
 *  or an Error to bubble as 400. Centralised because three endpoints share
 *  the same constraint and were drifting. */
function parseSinceQuery(raw: unknown): number | undefined | Error {
  if (raw === undefined) return undefined;
  const s = Number(raw);
  if (!Number.isSafeInteger(s) || s < 0) {
    return new Error("since: must be a non-negative integer (unix seconds)");
  }
  return s;
}

/**
 * Phase 2.5a — settlements push API.
 * Phase 2.5c — read endpoints (this PR): list / per-relayer stats / network totals.
 * Phase 2.5b — verify job (next): not part of this surface, just sets verified=1.
 *
 * Write auth: EIP-191 relayer signature middleware. Reads are public
 * (rate-limited by the same readLimiter as /api/orders).
 */
export function createSettlementRoutes(
  db: OrderbookDB,
  writeLimiter: RequestHandler,
  readLimiter: RequestHandler,
  relayerWriteLimiter?: RequestHandler,
  /** Optional on-chain membership gate. When provided, a submitter that isn't
   *  an active relayer in the RelayerRegistry is rejected (403) — blocking
   *  fake-row injection at the source. Omitted → no gate (back-compat). */
  membership?: RelayerMembership,
): Router {
  const router = Router();

  const middleware: RequestHandler[] = [writeLimiter, relayerAuth];
  if (relayerWriteLimiter) middleware.push(relayerWriteLimiter);

  router.post("/", ...middleware, async (req, res) => {
    try {
      const { relayerAddress } = req as AuthenticatedRequest;
      const payload = parseSettlementInsert(req.body);

      // Cross-check: at least the `submitter` (auth) must equal one of the
      // sides. A relayer should never push a settlement it didn't take part
      // in — that would let it claim cross-relayer trades that aren't its.
      const submitter = relayerAddress.toLowerCase();
      const sides = [payload.makerRelayer.toLowerCase()];
      if (payload.takerRelayer) sides.push(payload.takerRelayer.toLowerCase());
      if (!sides.includes(submitter)) {
        res.status(403).json({ error: "submitter must be either makerRelayer or takerRelayer" });
        return;
      }

      // On-chain membership gate: the signature only proves key control, not
      // that the submitter is a real relayer. Reject non-members at the source
      // (the row cap/prune only bound the impact of rows that get through).
      if (membership) {
        const active = await membership.isActiveRelayer(payload.chainId ?? DEFAULT_CHAIN_ID, submitter);
        if (!active) {
          res.status(403).json({ error: "submitter is not an active relayer in the on-chain registry" });
          return;
        }
      }

      const inserted = db.insertSettlement(submitter, payload);
      // 201 on first write, 200 on idempotent retry — same shape either way.
      res.status(inserted ? 201 : 200).json({ txHash: payload.txHash, inserted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      res.status(400).json({ error: msg });
    }
  });

  /**
   * GET /api/settlements?relayer=&pair=&since=&limit=&offset=
   * Lists raw settlement rows, newest first. Pre-2.5b verify job, the
   * `verified` flag stays false on every row.
   */
  router.get("/", readLimiter, (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const relayer = typeof q.relayer === "string" ? q.relayer : undefined;
      if (relayer && !HEX_ADDR_RE.test(relayer)) {
        res.status(400).json({ error: "relayer: must be a 0x-prefixed address" });
        return;
      }
      let pair: [string, string] | undefined;
      if (typeof q.pair === "string") {
        const parsed = isValidPair(q.pair);
        if (!parsed) {
          res.status(400).json({ error: "pair: must be 0xtokenA-0xtokenB" });
          return;
        }
        pair = parsed;
      }
      const since = parseSinceQuery(q.since);
      if (since instanceof Error) {
        res.status(400).json({ error: since.message });
        return;
      }
      const { limit, offset } = parseLimitOffset(q);
      const chainId = parseChainIdQuery(q.chainId);
      if (chainId instanceof Error) { res.status(400).json({ error: chainId.message }); return; }

      const rows = db.listSettlements({ chainId, relayer, pair, since, limit, offset });
      res.json({ settlements: rows, count: rows.length, offset });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "unknown error" });
    }
  });

  return router;
}

/**
 * GET /api/relayers/:addr/stats and GET /api/network/totals are mounted
 * under their own router so the URL hierarchy reads naturally. The DB
 * dependency is the same.
 */
export function createSettlementStatsRoutes(
  db: OrderbookDB,
  readLimiter: RequestHandler,
): Router {
  const router = Router();

  router.get("/relayers/:addr/stats", readLimiter, (req, res) => {
    const { addr } = req.params;
    if (!HEX_ADDR_RE.test(addr)) {
      res.status(400).json({ error: "addr: must be a 0x-prefixed address" });
      return;
    }
    const since = parseSinceQuery(req.query.since);
    if (since instanceof Error) { res.status(400).json({ error: since.message }); return; }
    const chainId = parseChainIdQuery(req.query.chainId);
    if (chainId instanceof Error) { res.status(400).json({ error: chainId.message }); return; }
    try {
      res.json(db.getRelayerSettlementStats(addr, chainId, since));
    } catch (err: unknown) {
      // DB locked / corrupt / unexpected aggregation error — return JSON
      // 500 like other DB-backed routes instead of Express's HTML default.
      res.status(500).json({ error: err instanceof Error ? err.message : "stats failed" });
    }
  });

  router.get("/network/totals", readLimiter, (req, res) => {
    const since = parseSinceQuery(req.query.since);
    if (since instanceof Error) { res.status(400).json({ error: since.message }); return; }
    const chainId = parseChainIdQuery(req.query.chainId);
    if (chainId instanceof Error) { res.status(400).json({ error: chainId.message }); return; }
    try {
      res.json(db.getNetworkSettlementTotals(chainId, since));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : "totals failed" });
    }
  });

  // Phase 3a — leaderboard. Ranking computed in SQL so the frontend
  // doesn't N+1 over /api/relayers/:addr/stats.
  router.get("/leaderboard", readLimiter, (req, res) => {
    const metric: LeaderboardMetric = isLeaderboardMetric(req.query.metric) ? req.query.metric : "count";
    if (req.query.metric !== undefined && !isLeaderboardMetric(req.query.metric)) {
      res.status(400).json({ error: `metric: must be one of ${LEADERBOARD_METRICS.join("|")}` });
      return;
    }
    const since = parseSinceQuery(req.query.since);
    if (since instanceof Error) { res.status(400).json({ error: since.message }); return; }
    let limit = 50;
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_LIMIT) {
        res.status(400).json({ error: `limit: must be an integer in [1, ${MAX_LIMIT}]` });
        return;
      }
      limit = n;
    }
    const chainId = parseChainIdQuery(req.query.chainId);
    if (chainId instanceof Error) { res.status(400).json({ error: chainId.message }); return; }
    try {
      const rows = db.getLeaderboard(chainId, metric, since, limit);
      res.json({ metric, since: since ?? null, count: rows.length, rows });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : "leaderboard failed" });
    }
  });

  return router;
}

function isLeaderboardMetric(v: unknown): v is LeaderboardMetric {
  return typeof v === "string" && (LEADERBOARD_METRICS as readonly string[]).includes(v);
}
