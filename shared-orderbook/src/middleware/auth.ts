import { verifyMessage } from "ethers";
import type { Request, Response, NextFunction } from "express";
import { eqAddr } from "../lib/address.js";

/**
 * EIP-191 relayer authentication middleware.
 *
 * Relayers sign a message with their private key to prove identity.
 * The signed message includes the request method + path to prevent
 * cross-endpoint replay attacks.
 *
 * Signed message format: "zkScatter-relay:{address}:{timestamp}:{METHOD}:{path}:{url}"
 * Including the URL prevents a relayer from signing with their key but spoofing another relayer's URL.
 *
 * Headers:
 *   x-relayer-address: 0x...
 *   x-relayer-signature: 0x...
 *   x-relayer-timestamp: unix timestamp (seconds)
 *   x-relayer-url: https://relayer.example.com (required for order/register routes)
 */
const SIGNATURE_MAX_AGE_SEC = 300; // 5 minutes

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

  // Verify EIP-191 signature (includes method+path+url to prevent replay and URL spoofing)
  const method = req.method.toUpperCase();
  const path = req.originalUrl.split("?")[0]; // strip query params
  const relayerUrl = (req.headers["x-relayer-url"] as string) || "";
  const message = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method}:${path}:${relayerUrl}`;
  try {
    const recovered = verifyMessage(message, signature);
    if (!eqAddr(recovered, address)) {
      res.status(401).json({ error: "signature mismatch" });
      return;
    }
  } catch {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // Attach verified relayer info to request
  (req as AuthenticatedRequest).relayerAddress = address.toLowerCase();
  (req as AuthenticatedRequest).relayerUrl = (req.headers["x-relayer-url"] as string) || "";

  next();
}

export interface AuthenticatedRequest extends Request {
  relayerAddress: string;
  relayerUrl: string;
}
