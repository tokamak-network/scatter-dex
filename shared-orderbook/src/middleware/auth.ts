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
 * Legacy message format (still accepted for one release):
 *   "zkScatter-relay:{address}:{timestamp}:{METHOD}:{path}:{url}"
 *
 *   The middleware tries the body-bound message first and falls back
 *   to the legacy form so a server upgraded ahead of its clients
 *   doesn't break them. Operators should set `REQUIRE_BODY_HASH=1`
 *   once every peer relayer is on the new SDK to disable the
 *   fallback. A `[deprecated-body-hash]` warning logs whenever the
 *   fallback is used.
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
  const requireBodyHash = process.env.REQUIRE_BODY_HASH === "1";

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

  // Fall back to legacy (no body hash) — one-release transition.
  if (!requireBodyHash) {
    const messageLegacy = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method}:${path}:${relayerUrl}`;
    try {
      const legacyRecovered = verifyMessage(messageLegacy, signature);
      if (eqAddr(legacyRecovered, address)) {
        console.warn(
          `[deprecated-body-hash] ${address} signed ${method} ${path} without body binding; upgrade client. Set REQUIRE_BODY_HASH=1 to reject after rollout.`,
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
