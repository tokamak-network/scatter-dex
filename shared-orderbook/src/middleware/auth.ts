import { createHash } from "crypto";
import { verifyMessage } from "ethers";
import type { Request, Response, NextFunction } from "express";
import { eqAddr } from "../lib/address.js";

/**
 * EIP-191 relayer authentication middleware.
 *
 * Relayers sign a message with their private key to prove identity.
 * The signed message binds method + path + URL + body hash to
 * prevent cross-endpoint and body-substitution replay attacks.
 *
 * Signed message format (current):
 *   "zkScatter-relay:{address}:{timestamp}:{METHOD}:{path}:{url}:{bodyHash}"
 *
 *   - `bodyHash` is `sha256(rawBody)` hex-prefixed `0x`. Empty body
 *     (e.g. GET / DELETE) hashes to the sha256 of zero bytes
 *     (`0xe3b0c4…852b855`). The middleware reads the raw bytes from
 *     `req.rawBody` (populated by the `express.json({ verify })`
 *     hook in `index.ts`).
 *
 * Legacy message format (fail-closed by default, off):
 *   "zkScatter-relay:{address}:{timestamp}:{METHOD}:{path}:{url}"
 *
 *   The body-binding transition release (PR #693, 2026-05) is over, so
 *   the legacy non-body-bound form is now REJECTED by default. Accepting
 *   it reopens a replay-modify window: an attacker who captures a legacy
 *   signature can swap the body and resend within the 5-minute freshness
 *   window. Operators who still run un-upgraded peers can re-enable the
 *   fallback with `ALLOW_LEGACY_RELAYER_SIG=1` (a `[deprecated-body-hash]`
 *   warning logs on every use); leave it unset in production.
 *
 * Headers (all required, except `x-relayer-url` which is required
 * for write endpoints only):
 *   x-relayer-address: 0x...
 *   x-relayer-signature: 0x...
 *   x-relayer-timestamp: unix timestamp (seconds)
 *   x-relayer-url: https://relayer.example.com
 */
const SIGNATURE_MAX_AGE_SEC = 300; // 5 minutes
const EMPTY_BODY_SHA256 =
  "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function bodyHashOf(rawBody: Buffer | undefined): string {
  if (!rawBody || rawBody.length === 0) return EMPTY_BODY_SHA256;
  return "0x" + createHash("sha256").update(rawBody).digest("hex");
}

export function relayerAuth(req: Request, res: Response, next: NextFunction): void {
  const address = req.headers["x-relayer-address"] as string | undefined;
  const signature = req.headers["x-relayer-signature"] as string | undefined;
  const timestamp = req.headers["x-relayer-timestamp"] as string | undefined;

  if (!address || !signature || !timestamp) {
    res.status(401).json({ error: "missing relayer auth headers" });
    return;
  }

  // Timestamp freshness check
  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isNaN(ts) || Math.abs(now - ts) > SIGNATURE_MAX_AGE_SEC) {
    res.status(401).json({ error: "signature expired or clock skew too large" });
    return;
  }

  const method = req.method.toUpperCase();
  const path = req.originalUrl.split("?")[0]; // strip query params
  const relayerUrl = (req.headers["x-relayer-url"] as string) || "";
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  const bodyHash = bodyHashOf(rawBody);

  const messageWithBody = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method}:${path}:${relayerUrl}:${bodyHash}`;
  // Fail-closed by default — the body-binding transition is complete.
  // Only an explicit opt-out re-enables the un-bound legacy signature.
  const allowLegacy = process.env.ALLOW_LEGACY_RELAYER_SIG === "1";

  let recovered: string | null = null;
  try {
    recovered = verifyMessage(messageWithBody, signature);
  } catch {
    recovered = null;
  }
  if (recovered && eqAddr(recovered, address)) {
    accept(req, address);
    next();
    return;
  }

  // Fall back to legacy (no body hash) only when explicitly opted in.
  if (allowLegacy) {
    const messageLegacy = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method}:${path}:${relayerUrl}`;
    try {
      const legacyRecovered = verifyMessage(messageLegacy, signature);
      if (eqAddr(legacyRecovered, address)) {
        console.warn(
          `[deprecated-body-hash] ${address} signed ${method} ${path} without body binding; upgrade client. Unset ALLOW_LEGACY_RELAYER_SIG to reject (default).`,
        );
        accept(req, address);
        next();
        return;
      }
    } catch {
      // fall through to reject
    }
  }

  res.status(401).json({ error: "signature mismatch" });
}

function accept(req: Request, address: string): void {
  (req as AuthenticatedRequest).relayerAddress = address.toLowerCase();
  (req as AuthenticatedRequest).relayerUrl = (req.headers["x-relayer-url"] as string) || "";
}

export interface AuthenticatedRequest extends Request {
  relayerAddress: string;
  relayerUrl: string;
}
