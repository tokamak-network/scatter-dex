import { Router } from "express";
import type { RequestHandler } from "express";
import type { OrderbookDB } from "../core/db.js";
import { parseSettlementInsert } from "../types/settlement.js";
import { isValidPair } from "../types/order.js";
import { relayerAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_LIMIT = 500;

function parseLimitOffset(q: Record<string, unknown>): { limit: number; offset: number } {
  // Distinguish absent from explicit 0/NaN — `Number(undefined) || 100`
  // would silently turn `?limit=0` into 100, which is misleading. With
  // an explicit absence check, `?limit=0` clamps up to 1 (the min).
  const parsedLimit = q.limit === undefined ? 100 : Number(q.limit);
  const parsedOffset = q.offset === undefined ? 0 : Number(q.offset);
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 100, 1), MAX_LIMIT);
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
): Router {
  const router = Router();

  const middleware: RequestHandler[] = [writeLimiter, relayerAuth];
  if (relayerWriteLimiter) middleware.push(relayerWriteLimiter);

  router.post("/", ...middleware, (req, res) => {
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

      const rows = db.listSettlements({ relayer, pair, since, limit, offset });
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
    try {
      res.json(db.getRelayerSettlementStats(addr, since));
    } catch (err: unknown) {
      // DB locked / corrupt / unexpected aggregation error — return JSON
      // 500 like other DB-backed routes instead of Express's HTML default.
      res.status(500).json({ error: err instanceof Error ? err.message : "stats failed" });
    }
  });

  router.get("/network/totals", readLimiter, (req, res) => {
    const since = parseSinceQuery(req.query.since);
    if (since instanceof Error) { res.status(400).json({ error: since.message }); return; }
    try {
      res.json(db.getNetworkSettlementTotals(since));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : "totals failed" });
    }
  });

  return router;
}
