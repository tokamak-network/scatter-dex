import { Request, Response, RequestHandler } from "express";
import type { AdminSiweAuth } from "../core/admin-siwe.js";

const BEARER_PREFIX = "Bearer ";

// Process-wide SIWE handle, published by the admin route module at
// boot. Lives at module scope so sibling route files (vault, etc.)
// can share the same auth surface via the default `adminAuth` export
// without each setup function having to thread the instance through
// — admin endpoints across routers should accept the same tokens.
// Tests construct their own middleware via `buildAdminAuth(siwe)`
// instead of touching this singleton, so cross-test pollution is
// avoided.
let registeredSiwe: AdminSiweAuth | null = null;
export function setSiweAuth(instance: AdminSiweAuth | null): void {
  registeredSiwe = instance;
}

/** Build an admin-endpoint gate that accepts a SIWE session token via
 *  `Authorization: Bearer <session-token>`. The token is minted by
 *  `POST /api/admin/session` after the operator signs a challenge with
 *  the wallet registered as this relayer's operator (see admin-siwe.ts).
 *  `siwe` is null only in defensive/test paths — a real relayer always
 *  wires it at boot, so a null here fails closed with a 403. */
export function buildAdminAuth(siwe: AdminSiweAuth | null): RequestHandler {
  return function adminAuth(req: Request, res: Response, next: () => void) {
    // No SIWE wired (defensive/misconfiguration) — fail closed so a
    // missing auth surface can't accidentally expose admin endpoints.
    if (!siwe) {
      res.status(403).json({ error: "Admin auth is not configured on this relayer" });
      return;
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length).trim();
      if (token && siwe.verifySession(token) !== null) {
        next();
        return;
      }
    }
    // No valid bearer — the only accepted credential. The UI routes the
    // operator back to AdminConnectBar to (re-)sign in.
    res.status(401).json({ error: "Bearer session token required" });
  };
}

/** Default middleware bound to the module-scope SIWE singleton. Used
 *  by route files that share the same auth surface as the main admin
 *  router (e.g. `routes/vault.ts`'s admin-claim endpoint). The lookup
 *  is per-request — there's no closure over the SIWE handle — so
 *  `setSiweAuth` after middleware construction still takes effect on
 *  the next request. */
export const adminAuth: RequestHandler = (req, res, next) =>
  buildAdminAuth(registeredSiwe)(req, res, next);
