import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AdminSiweAuth } from "../core/admin-siwe.js";

/**
 * Auth for operator-only endpoints (/api/admin, KYC review). Accepts a
 * `Authorization: Bearer <token>` that is **either**:
 *
 *   - a SIWE session token (wallet-signature flow, when ADMIN_ADDRESSES is
 *     configured), tried first — a cheap Map.get; or
 *   - the static `ADMIN_TOKEN` bearer (legacy / CI path), compared in
 *     constant time.
 *
 * Both can be enabled at once so a deployment can migrate to the wallet flow
 * at its own pace. If neither is configured, every guarded endpoint returns
 * 503 (disabled). Meant for a small set of ops users, not end-user-facing.
 */
interface AdminAuthOptions {
  siwe?: AdminSiweAuth | null;
  staticToken?: string;
}

const BEARER_PREFIX = "Bearer ";

function bearerOf(req: Request): string | null {
  const header = (req.headers.authorization ?? "").trim();
  if (!header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token || null;
}

/** Constant-time string compare that never short-circuits on length. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const len = Math.max(ab.length, bb.length);
  const ap = Buffer.alloc(len);
  ab.copy(ap);
  const bp = Buffer.alloc(len);
  bb.copy(bp);
  return timingSafeEqual(ap, bp) && ab.length === bb.length;
}

export function makeAdminAuth(opts: AdminAuthOptions): RequestHandler {
  const { siwe, staticToken } = opts;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!siwe && !staticToken) {
      res.status(503).json({
        error: "admin endpoints disabled (set ADMIN_TOKEN or ADMIN_ADDRESSES to enable)",
      });
      return;
    }
    const token = bearerOf(req);
    if (!token) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    // SIWE session token (wallet flow) — tried first; a plain Map.get.
    if (siwe && siwe.verifySession(token) !== null) {
      next();
      return;
    }
    // Static token (legacy / CI) — constant-time compare.
    if (staticToken && timingSafeEqualStr(token, staticToken)) {
      next();
      return;
    }
    res.status(401).json({ error: "invalid or expired bearer token" });
  };
}
