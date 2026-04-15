import { Router } from "express";
import type { RequestHandler } from "express";
import type { OrderbookDB } from "../core/db.js";
import { parseSettlementInsert } from "../types/settlement.js";
import { relayerAuth, type AuthenticatedRequest } from "../middleware/auth.js";

/**
 * Phase 2.5a — settlements push API. Relayers POST a record after a
 * successful settle tx; the verify job (Phase 2.5b) and read APIs
 * (Phase 2.5c) come in follow-up PRs.
 *
 * Auth: same EIP-191 relayer signature middleware as orders. The
 * authenticated address becomes `submitter` so a relayer cannot
 * attribute settlements to someone else.
 */
export function createSettlementRoutes(
  db: OrderbookDB,
  writeLimiter: RequestHandler,
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

  return router;
}
