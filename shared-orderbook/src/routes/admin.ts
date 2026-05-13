/**
 * Operator-only endpoints. Auth uses a static bearer token compared
 * with `timingSafeEqual` — meant for a single ops/monitoring user, not
 * end-user-facing. If `ADMIN_TOKEN` is unset, every admin endpoint
 * returns 503 (disabled). Setting an empty `ADMIN_TOKEN` also disables
 * it; we require a non-empty token to enable.
 */
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { timingSafeEqual } from "crypto";
import type { OrderbookDB } from "../core/db.js";
import type { VerifyMonitor } from "../core/verify-runtime.js";

function makeAdminAuth(token: string | undefined): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      res.status(503).json({ error: "admin endpoints disabled (set ADMIN_TOKEN to enable)" });
      return;
    }
    const header = (req.headers.authorization ?? "").trim();
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!supplied) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    // Constant-time compare. Pad both sides to the same length and ALWAYS
    // run `timingSafeEqual` regardless of length so a prefix/short token
    // doesn't return earlier than a same-length wrong token. The length
    // check is folded into the final boolean, not into control flow.
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    const len = Math.max(a.length, b.length);
    const ap = Buffer.alloc(len);
    a.copy(ap);
    const bp = Buffer.alloc(len);
    b.copy(bp);
    const bytesEq = timingSafeEqual(ap, bp);
    const lenEq = a.length === b.length;
    if (!(bytesEq && lenEq)) {
      res.status(401).json({ error: "invalid bearer token" });
      return;
    }
    next();
  };
}

export interface AdminDeps {
  db: OrderbookDB;
  monitor: VerifyMonitor;
  adminToken: string | undefined;
}

export function createAdminRoutes(deps: AdminDeps): Router {
  const router = Router();
  const auth = makeAdminAuth(deps.adminToken);

  /**
   * GET /api/admin/verify-stats
   *
   * Reports the last verify pass plus the DB-level unverified count.
   * The count is what an operator actually wants for alerting — if it
   * stays elevated for hours, something upstream is broken (RPC down,
   * contract address wrong, relayer pushing rows the chain never
   * confirms). `oldestUnverifiedBlock` adds the leading edge so ops
   * can correlate against chain head.
   */
  router.get("/verify-stats", auth, (_req, res) => {
    const monSnap = deps.monitor.snapshot();
    const unverifiedCount = deps.db.countUnverifiedSettlements();
    const unverifiedSample = unverifiedCount > 0 ? deps.db.listUnverifiedSettlements({ limit: 1 }) : [];
    res.json({
      ...monSnap,
      unverifiedCount,
      hasUnverifiedRows: unverifiedCount > 0,
      oldestUnverifiedBlock: unverifiedSample[0]?.blockNumber ?? null,
    });
  });

  return router;
}
