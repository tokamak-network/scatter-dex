/**
 * Operator-only endpoints (verify-stats + the SIWE challenge/session flow
 * that mints admin tokens). Auth is a shared `adminAuth` middleware that
 * accepts a SIWE session token or the static ADMIN_TOKEN — see
 * `middleware/admin-auth.ts`. Meant for a small set of ops users.
 */
import { Router, type Request, type Response, type RequestHandler } from "express";
import type { OrderbookDB } from "../core/db.js";
import type { VerifyMonitor } from "../core/verify-runtime.js";
import type { AdminSiweAuth } from "../core/admin-siwe.js";

export interface AdminDeps {
  db: OrderbookDB;
  monitor: VerifyMonitor;
  /** Shared admin gate (SIWE session token OR static ADMIN_TOKEN). */
  adminAuth: RequestHandler;
  /** SIWE handle — present only when ADMIN_ADDRESSES is configured. When
   *  null, the challenge/session endpoints are not mounted (404). */
  siwe?: AdminSiweAuth | null;
  /** Rate limiter for the public challenge/session endpoints (bounds the
   *  in-memory nonce map against unauthenticated spam). */
  writeLimiter?: RequestHandler;
}

export function createAdminRoutes(deps: AdminDeps): Router {
  const router = Router();
  const { db, monitor, adminAuth, siwe, writeLimiter } = deps;
  const wl = writeLimiter ? [writeLimiter] : [];

  // ── SIWE wallet-signature auth (mounted only when ADMIN_ADDRESSES is set) ─
  // The challenge/session endpoints are public — an admin needs them to mint
  // and exchange a challenge before they hold any token. Both sit behind the
  // writeLimiter: each /challenge call grows the in-memory nonce map until its
  // 60s TTL elapses, so an unauthenticated caller could otherwise spam memory.
  if (siwe) {
    router.get("/challenge", ...wl, (_req: Request, res: Response) => {
      // The SIWE module owns the canonical message format — issuing it here
      // would risk client/server drift vs createSession's exact-match check.
      res.json(siwe.issueChallenge());
    });

    router.post("/session", ...wl, async (req: Request, res: Response) => {
      const { nonce, message, signature } = req.body ?? {};
      if (typeof nonce !== "string" || typeof message !== "string" || typeof signature !== "string") {
        res.status(400).json({ error: "nonce, message, signature required (strings)" });
        return;
      }
      try {
        const session = await siwe.createSession({ nonce, message, signature });
        res.json(session);
      } catch (err) {
        res.status(401).json({ error: err instanceof Error ? err.message : "session creation failed" });
      }
    });

    // Explicit logout. Idempotent. Reads the bearer token directly rather than
    // going through adminAuth (a stale token should still be revocable).
    router.post("/session/revoke", (req: Request, res: Response) => {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        siwe.revokeSession(header.slice("Bearer ".length).trim());
      }
      res.status(204).end();
    });
  }

  /**
   * GET /api/admin/verify-stats
   *
   * Reports the last verify pass plus the DB-level unverified count. The count
   * is what an operator actually wants for alerting — if it stays elevated for
   * hours, something upstream is broken. `oldestUnverifiedBlock` adds the
   * leading edge so ops can correlate against chain head.
   */
  router.get("/verify-stats", adminAuth, (_req, res) => {
    const monSnap = monitor.snapshot();
    const unverifiedCount = db.countUnverifiedSettlements();
    const unverifiedSample = unverifiedCount > 0 ? db.listUnverifiedSettlements({ limit: 1 }) : [];
    res.json({
      ...monSnap,
      unverifiedCount,
      hasUnverifiedRows: unverifiedCount > 0,
      oldestUnverifiedBlock: unverifiedSample[0]?.blockNumber ?? null,
    });
  });

  return router;
}
