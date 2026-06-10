import { Router } from "express";
import type { RequestHandler } from "express";
import { clampLimit } from "@scatter-dex/types";
import type { OrderbookDB } from "../core/db.js";
import { parseChainIdQuery } from "../core/chain.js";

/** Page size bounds. `limit` is hard-capped so a `limit=10^9` can't force a
 *  giant query/response; clients page by advancing `fromLeaf`. */
const MAX_LIMIT = 10_000;
const DEFAULT_LIMIT = 5_000;

export function createCommitmentRoutes(db: OrderbookDB, readLimiter: RequestHandler): Router {
  const router = Router();

  /**
   * GET /api/commitments?chainId=&fromLeaf=&limit=
   *
   * Public read. Returns commitment-tree leaves for a chain from `fromLeaf`
   * (inclusive), ascending by leafIndex. The client replays them into its own
   * tree and verifies the root on-chain (`isKnownRoot`) before trusting it, so
   * this endpoint is untrusted convenience — the data is public on-chain.
   */
  router.get("/", readLimiter, (req, res) => {
    const chainId = parseChainIdQuery(req.query.chainId);
    if (chainId instanceof Error) {
      res.status(400).json({ error: chainId.message });
      return;
    }

    const fromLeaf = Number(req.query.fromLeaf ?? 0);
    if (!Number.isInteger(fromLeaf) || fromLeaf < 0) {
      res.status(400).json({ error: "fromLeaf must be a non-negative integer" });
      return;
    }

    const limit = clampLimit(req.query.limit, MAX_LIMIT, DEFAULT_LIMIT);

    const commitments = db.listCommitments(chainId, fromLeaf, limit);
    const total = db.commitmentCount(chainId);
    res.json({ chainId, fromLeaf, total, commitments });
  });

  return router;
}
