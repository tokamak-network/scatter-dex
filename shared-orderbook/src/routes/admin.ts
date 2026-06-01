/**
 * Operator-only endpoints. Auth uses a static bearer token compared with
 * `timingSafeEqual` (see `middleware/admin-auth.ts`) — meant for a single
 * ops/monitoring user, not end-user-facing.
 */
import { Router } from "express";
import type { OrderbookDB } from "../core/db.js";
import type { VerifyMonitor } from "../core/verify-runtime.js";
import { makeAdminAuth } from "../middleware/admin-auth.js";

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
