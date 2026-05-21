import { Request, Response, RequestHandler } from "express";
import { timingSafeEqual } from "crypto";
import { config } from "../config.js";
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

/** Build an admin-endpoint gate that accepts either:
 *
 *   - `Authorization: Bearer <session-token>` (SIWE path), or
 *   - `x-admin-key: <ADMIN_API_KEY>` header (legacy / CI path)
 *
 *  At least one mechanism must be configured at boot; routes mounted
 *  under this middleware with neither path enabled would 403 every
 *  request, surfacing the misconfiguration immediately rather than
 *  later. */
export function buildAdminAuth(siwe: AdminSiweAuth | null): RequestHandler {
  return function adminAuth(req: Request, res: Response, next: () => void) {
    // Bearer-token path (SIWE) — only attempted when a SIWE instance
    // is wired (i.e. `RELAYER_REGISTRY_ADDRESS` is set). Tried first
    // because operators on the wallet flow get the cheaper path (one
    // Map.get vs the timing-safe key compare).
    const authHeader = req.headers.authorization;
    if (siwe && typeof authHeader === "string" && authHeader.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length).trim();
      if (token && siwe.verifySession(token) !== null) {
        next();
        return;
      }
      // Fall through to the key path so a stale session doesn't lock
      // out a deploy that still has `ADMIN_API_KEY` configured for
      // CI / scripts.
    }

    const key = config.adminApiKey;
    if (!key) {
      // Neither path admissible — fail closed.
      if (!siwe) {
        res.status(403).json({ error: "Admin auth is not configured on this relayer" });
        return;
      }
      res.status(401).json({ error: "Bearer session token required" });
      return;
    }
    const provided = req.headers["x-admin-key"];
    if (typeof provided !== "string" || Buffer.byteLength(provided) !== key.length) {
      res.status(401).json({ error: "Invalid admin API key" });
      return;
    }
    const providedBuf = Buffer.from(provided);
    if (!timingSafeEqual(providedBuf, key)) {
      res.status(401).json({ error: "Invalid admin API key" });
      return;
    }
    next();
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
