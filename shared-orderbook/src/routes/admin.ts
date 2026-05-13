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
    // Constant-time compare — pad both sides to the same length to avoid
    // a length-based early exit from `timingSafeEqual`.
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    const len = Math.max(a.length, b.length);
    const ap = Buffer.alloc(len);
    a.copy(ap);
    const bp = Buffer.alloc(len);
    b.copy(bp);
    if (a.length !== b.length || !timingSafeEqual(ap, bp)) {
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
   * Reports the last verify pass plus a rolling DB count of how many
   * settlements are still unverified. The DB count is what an operator
   * actually wants for alerting — if it stays > 0 for hours, something
   * upstream is broken (RPC down, contract address wrong, relayer
   * pushing rows the chain never confirms).
   */
  router.get("/verify-stats", auth, (_req, res) => {
    const monSnap = deps.monitor.snapshot();
    const unverifiedSample = deps.db.listUnverifiedSettlements({ limit: 1 });
    res.json({
      ...monSnap,
      hasUnverifiedRows: unverifiedSample.length > 0,
      oldestUnverifiedBlock: unverifiedSample[0]?.blockNumber ?? null,
    });
  });

  return router;
}
