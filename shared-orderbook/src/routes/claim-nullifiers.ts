import { Router } from "express";
import type { Response, RequestHandler } from "express";
import type { OrderbookDB } from "../core/db.js";
import { parseChainIdQuery } from "../core/chain.js";

/** Max nullifiers per request. Bounds the IN-list so a giant request can't
 *  force an unbounded SQL statement; a client with more leaves pages by
 *  splitting the list. */
const MAX_NULLIFIERS = 512;

/** Canonical claim nullifier: 0x + 32 bytes hex. The client sends
 *  `toBytes32Hex(computeClaimNullifier(secret, leafIndex))`, so anything else
 *  is a malformed request, not a miss. */
const NULLIFIER_RE = /^0x[0-9a-fA-F]{64}$/;

/** Validate a nullifier list and, if valid, write the spent subset to the
 *  response. Shared by the GET (small/debug) and POST (batch) handlers so the
 *  two stay in lockstep. Returns nothing — it has already sent the response. */
function respondSpent(
  db: OrderbookDB,
  res: Response,
  chainId: number,
  nullifiers: string[],
): void {
  if (nullifiers.length === 0) {
    res.status(400).json({ error: "nullifiers must contain at least one value" });
    return;
  }
  if (nullifiers.length > MAX_NULLIFIERS) {
    res.status(400).json({ error: `at most ${MAX_NULLIFIERS} nullifiers per request` });
    return;
  }
  const bad = nullifiers.find((n) => typeof n !== "string" || !NULLIFIER_RE.test(n));
  if (bad !== undefined) {
    res.status(400).json({ error: `invalid nullifier: ${bad}` });
    return;
  }
  const spent = db.getSpentClaimNullifiers(chainId, nullifiers);
  res.json({ chainId, spent });
}

export function createClaimNullifierRoutes(db: OrderbookDB, readLimiter: RequestHandler): Router {
  const router = Router();

  /**
   * GET  /api/claim-nullifiers?chainId=&nullifiers=0x..,0x..
   * POST /api/claim-nullifiers   { chainId, nullifiers: string[] }
   *
   * Public read. Given a list of claim nullifiers, returns the subset that are
   * already spent on-chain (a `PrivateClaim` landed for them). Nullifiers are
   * monotonic — once spent, always spent — so a client caches the spent set
   * and never re-queries those. Absence from `spent` means "not seen spent
   * yet" (could still be unclaimed, or the indexer is behind head); the client
   * falls back to its optimistic local state or an RPC probe for those.
   *
   * Prefer POST for real batches: a 128-recipient GET URL (~8.6 KB) can trip
   * proxy/CDN request-target limits and 414. GET stays for small/debug calls.
   */
  router.get("/", readLimiter, (req, res) => {
    const chainId = parseChainIdQuery(req.query.chainId);
    if (chainId instanceof Error) {
      res.status(400).json({ error: chainId.message });
      return;
    }
    const raw = req.query.nullifiers;
    if (typeof raw !== "string" || raw.trim() === "") {
      res.status(400).json({ error: "nullifiers must be a comma-separated list" });
      return;
    }
    const nullifiers = raw.split(",").map((n) => n.trim()).filter((n) => n !== "");
    respondSpent(db, res, chainId, nullifiers);
  });

  router.post("/", readLimiter, (req, res) => {
    const body = (req.body ?? {}) as { chainId?: unknown; nullifiers?: unknown };
    const chainId = parseChainIdQuery(body.chainId);
    if (chainId instanceof Error) {
      res.status(400).json({ error: chainId.message });
      return;
    }
    if (!Array.isArray(body.nullifiers)) {
      res.status(400).json({ error: "nullifiers must be an array" });
      return;
    }
    respondSpent(db, res, chainId, body.nullifiers as string[]);
  });

  return router;
}
