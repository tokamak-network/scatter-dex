/**
 * Wallet-signature admin auth for the operator console.
 *
 * Flow:
 *   1. Client GETs /api/admin/challenge → server returns a fresh
 *      nonce (single-use, 60s TTL). The nonce is keyed by itself —
 *      we don't bind it to an address up-front because the client
 *      may not have signed yet.
 *   2. Client builds the message (see `formatChallengeMessage`) and
 *      signs it with the operator's wallet, then POSTs the signature
 *      to /api/admin/session.
 *   3. Server recovers the signer via `ethers.verifyMessage`, looks
 *      up `RelayerRegistry.isActiveRelayer(signer)`, and on success
 *      issues a session token (15-min TTL) that downstream admin
 *      endpoints accept via `Authorization: Bearer <token>`.
 *
 * The stores are in-memory — a relayer restart invalidates active
 * sessions, which is acceptable since restarts are operator-driven
 * (re-sign takes seconds) and there's only one process.
 */

import { randomBytes } from "node:crypto";
import { ethers } from "ethers";

const NONCE_TTL_MS = 60_000;
const SESSION_TTL_MS = 15 * 60_000;
const NONCE_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;

const RELAYER_REGISTRY_ABI = [
  "function isActiveRelayer(address relayer) view returns (bool)",
] as const;

interface NonceEntry {
  expiresAt: number;
}

interface SessionEntry {
  address: string;
  expiresAt: number;
}

/** Factory: wire an on-chain `RelayerRegistry.isActiveRelayer` probe
 *  into the SIWE auth. Kept separate from the class so unit tests can
 *  inject a fake verifier without a JSON-RPC provider. */
export function makeAdminSiweAuthFromChain(
  registryAddress: string,
  provider: ethers.JsonRpcProvider,
): AdminSiweAuth {
  const registry = new ethers.Contract(
    registryAddress,
    RELAYER_REGISTRY_ABI,
    provider,
  );
  return new AdminSiweAuth(async (addr: string) =>
    (await registry.isActiveRelayer(addr)) as boolean,
  );
}

/** Issues challenges, verifies signatures, and tracks live sessions.
 *  Built once per process; admin routes use `issueChallenge`,
 *  `createSession`, and `verifySession` to drive the flow. */
export class AdminSiweAuth {
  private nonces = new Map<string, NonceEntry>();
  private sessions = new Map<string, SessionEntry>();
  constructor(
    private verifyActive: (address: string) => Promise<boolean>,
  ) {}

  /** Reserve a fresh nonce. Caller is responsible for consuming it
   *  via `createSession` before `NONCE_TTL_MS` elapses. */
  issueChallenge(): { nonce: string; expiresAt: number } {
    this.purgeExpired();
    const nonce = randomBytes(NONCE_BYTES).toString("hex");
    const expiresAt = Date.now() + NONCE_TTL_MS;
    this.nonces.set(nonce, { expiresAt });
    return { nonce, expiresAt };
  }

  /** Verify the signature, ensure the signer is an active relayer in
   *  the registry, and mint a session token. The nonce is consumed
   *  on success **and** on signature-mismatch — anything that proves
   *  the client saw it (or tried to) burns the slot, so replay
   *  windows stay tight. */
  async createSession(input: {
    nonce: string;
    message: string;
    signature: string;
  }): Promise<{ token: string; address: string; expiresAt: number }> {
    const { nonce, message, signature } = input;
    this.purgeExpired();
    const entry = this.nonces.get(nonce);
    if (!entry) throw new Error("Unknown or expired challenge nonce");
    // Burn the nonce up-front so a malformed signature can't be
    // replayed against the same nonce while the operator types a
    // second time. The client retries with a fresh challenge.
    this.nonces.delete(nonce);
    if (entry.expiresAt <= Date.now()) {
      throw new Error("Challenge nonce expired");
    }
    if (!message.includes(nonce)) {
      throw new Error("Message does not reference the issued nonce");
    }
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch (err) {
      throw new Error(
        `Signature recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const isActive: boolean = await this.verifyActive(recovered);
    if (!isActive) {
      throw new Error("Signer is not an active relayer in the registry");
    }
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { address: recovered.toLowerCase(), expiresAt });
    return { token, address: recovered, expiresAt };
  }

  /** Returns the bound address on hit, null when the token is unknown
   *  or has expired. Tokens are 32 bytes of `crypto.randomBytes`, so a
   *  plain `Map.get` is safe: the lookup key *is* the secret (there's
   *  no shorter "prefix" an attacker could guess and time toward), and
   *  the hash compare doesn't leak useful timing on uniformly-random
   *  hex strings. */
  verifySession(token: string): string | null {
    this.purgeExpired();
    const entry = this.sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return entry.address;
  }

  /** Explicit logout. Idempotent — unknown tokens are silently
   *  dropped, matching how the client treats a 401 from a stale
   *  session (just re-sign). */
  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [n, e] of this.nonces) {
      if (e.expiresAt <= now) this.nonces.delete(n);
    }
    for (const [t, e] of this.sessions) {
      if (e.expiresAt <= now) this.sessions.delete(t);
    }
  }
}

/** Canonical challenge message. The client must produce **exactly**
 *  this string for the server's recovered signature to match. Kept
 *  ASCII + LF so a copy/paste through any wallet UI doesn't mutate
 *  the bytes. The `Issued At` line ties the message to a wall-clock
 *  moment so an out-of-band capture loses meaning once the nonce
 *  expires. */
export function formatChallengeMessage(input: {
  nonce: string;
  issuedAt: string;
  domain?: string;
}): string {
  const domain = input.domain ?? "zkscatter operators admin";
  return [
    `${domain} wants you to sign in to manage this relayer.`,
    "",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}
