import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Static bearer-token auth for operator-only endpoints (/api/admin, KYC
 * review). Meant for a single ops/monitoring user, not end-user-facing. If
 * the token is unset, every guarded endpoint returns 503 (disabled); an empty
 * token also disables it — a non-empty token is required to enable.
 *
 * Lives in middleware/ (alongside `auth.ts`) so multiple route modules can
 * share one implementation instead of importing it from a sibling route file.
 */
export function makeAdminAuth(token: string | undefined): RequestHandler {
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
