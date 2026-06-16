import { Router } from "express";
import type { RequestHandler } from "express";
import type { OrderbookDB } from "../core/db.js";
import { parseChainIdQuery } from "../core/chain.js";

/** Max nullifiers per request. Bounds the IN-list so a giant query string
 *  can't force an unbounded SQL statement; a client with more leaves pages by
 *  splitting the list (one order caps at 128 recipients, so this covers
 *  several orders in one call). */
const MAX_NULLIFIERS = 512;

/** Canonical claim nullifier: 0x + 32 bytes hex. The client sends
 *  `toBytes32Hex(computeClaimNullifier(secret, leafIndex))`, so anything else
 *  is a malformed request, not a miss. */
const NULLIFIER_RE = /^0x[0-9a-fA-F]{64}$/;

export function createClaimNullifierRoutes(db: OrderbookDB, readLimiter: RequestHandler): Router {
  const router = Router();

  /**
   * GET /api/claim-nullifiers?chainId=&nullifiers=0x..,0x..
   *
   * Public read. Given a list of claim nullifiers, returns the subset that are
   * already spent on-chain (a `PrivateClaim` landed for them). Nullifiers are
   * monotonic — once spent, always spent — so a client caches the spent set
   * and never re-queries those. Absence from `spent` means "not seen spent
   * yet" (could still be unclaimed, or the indexer is behind head); the client
   * falls back to its optimistic local state or an RPC probe for those.
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
    if (nullifiers.length === 0) {
      res.status(400).json({ error: "nullifiers must contain at least one value" });
      return;
    }
    if (nullifiers.length > MAX_NULLIFIERS) {
      res.status(400).json({ error: `at most ${MAX_NULLIFIERS} nullifiers per request` });
      return;
    }
    const bad = nullifiers.find((n) => !NULLIFIER_RE.test(n));
    if (bad !== undefined) {
      res.status(400).json({ error: `invalid nullifier: ${bad}` });
      return;
    }

    const spent = db.getSpentClaimNullifiers(chainId, nullifiers);
    res.json({ chainId, spent });
  });

  return router;
}
