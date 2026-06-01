/**
 * Wallet-signature (SIWE-style) admin auth for the shared-orderbook KYC
 * review console.
 *
 * Mirrors the proven flow in `zk-relayer/src/core/admin-siwe.ts`, with one
 * difference: admin identity is decided by an injected `verifyAdmin` probe
 * (here, an `ADMIN_ADDRESSES` allowlist) rather than an on-chain
 * `RelayerRegistry.isActiveRelayer` read — the orderbook has no chain RPC.
 *
 * NOTE: the `AdminSiweAuth` class + `formatChallengeMessage` here are a
 * deliberate port of the zk-relayer implementation (only the injected probe
 * and the message domain differ). A follow-up could hoist the shared core
 * into `@scatter-dex/types` and have both services import it; kept local for
 * now to keep this change scoped to shared-orderbook.
 *
 * Flow:
 *   1. Client GETs /api/admin/challenge → server returns a fresh nonce
 *      (single-use, 60s TTL) plus the exact message to sign.
 *   2. Client signs that message with the admin wallet and POSTs
 *      { nonce, message, signature } to /api/admin/session.
 *   3. Server recovers the signer via `ethers.verifyMessage`, checks it
 *      against `verifyAdmin`, and on success issues a session token
 *      (15-min TTL) accepted by admin endpoints via `Authorization:
 *      Bearer <token>`.
 *
 * The nonce + session stores are in-memory — a server restart invalidates
 * active sessions, which is acceptable (re-sign takes seconds, single
 * process).
 */

import { randomBytes } from "node:crypto";
import { ethers } from "ethers";

const NONCE_TTL_MS = 60_000;
const SESSION_TTL_MS = 15 * 60_000;
// Gate the O(n) sweep across both maps to at most once per this many ms.
// Per-entry expiry is still checked on every read (see verifySession), so a
// stale row never becomes accessible just because the sweep hasn't run yet.
const PURGE_INTERVAL_MS = 30_000;
const NONCE_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;

interface NonceEntry {
  expiresAt: number;
  /** Exact challenge message bound to this nonce. The client must present
   *  the byte-identical string back in `createSession` — this prevents an
   *  attacker from getting an admin to sign an innocuous-looking message
   *  that merely contains the nonce somewhere in its body. */
  message: string;
}

interface SessionEntry {
  address: string;
  expiresAt: number;
}

/**
 * Build a SIWE auth backed by a static address allowlist (the
 * `ADMIN_ADDRESSES` env). Addresses are compared case-insensitively.
 * Returns null when the allowlist is empty so callers can treat "no
 * allowlist" as "SIWE disabled".
 */
export function makeAdminSiweFromAllowlist(addresses: Iterable<string>): AdminSiweAuth | null {
  const allow = new Set<string>();
  for (const a of addresses) {
    const trimmed = a.trim().toLowerCase();
    if (trimmed) allow.add(trimmed);
  }
  if (allow.size === 0) return null;
  return new AdminSiweAuth((addr: string) => allow.has(addr.toLowerCase()));
}

/** Issues challenges, verifies signatures, and tracks live sessions. Built
 *  once per process; admin routes use `issueChallenge`, `createSession`,
 *  `verifySession`, and `revokeSession` to drive the flow. */
export class AdminSiweAuth {
  private nonces = new Map<string, NonceEntry>();
  private sessions = new Map<string, SessionEntry>();
  private lastPurgeAt = 0;

  constructor(private verifyAdmin: (address: string) => boolean | Promise<boolean>) {}

  /** Reserve a fresh nonce and the canonical message that must be signed
   *  against it. Caller consumes it via `createSession` before NONCE_TTL_MS. */
  issueChallenge(): { nonce: string; expiresAt: number; issuedAt: string; message: string } {
    this.purgeExpired();
    const nonce = randomBytes(NONCE_BYTES).toString("hex");
    const expiresAt = Date.now() + NONCE_TTL_MS;
    const issuedAt = new Date().toISOString();
    const message = formatChallengeMessage({ nonce, issuedAt });
    this.nonces.set(nonce, { expiresAt, message });
    return { nonce, expiresAt, issuedAt, message };
  }

  /** Verify the signature, ensure the signer is an authorized admin, and
   *  mint a session token. The nonce is consumed on success **and** on
   *  signature-mismatch — anything that proves the client saw it (or tried)
   *  burns the slot, so replay windows stay tight. */
  async createSession(input: {
    nonce: string;
    message: string;
    signature: string;
  }): Promise<{ token: string; address: string; expiresAt: number }> {
    const { nonce, message, signature } = input;
    this.purgeExpired();
    const entry = this.nonces.get(nonce);
    if (!entry) throw new Error("Unknown or expired challenge nonce");
    // Burn the nonce up-front so a malformed signature can't be replayed
    // against the same nonce while the admin re-signs. Client retries with a
    // fresh challenge.
    this.nonces.delete(nonce);
    if (entry.expiresAt <= Date.now()) {
      throw new Error("Challenge nonce expired");
    }
    // Exact-match against the message issued *with this nonce*. A permissive
    // `includes(nonce)` check would let an attacker craft an innocuous
    // message containing the nonce and trick an admin into signing it.
    if (message !== entry.message) {
      throw new Error("Message does not match the issued challenge");
    }
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch (err) {
      throw new Error(
        `Signature recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const isAdmin = await this.verifyAdmin(recovered);
    if (!isAdmin) {
      throw new Error("Signer is not an authorized admin");
    }
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { address: recovered.toLowerCase(), expiresAt });
    return { token, address: recovered, expiresAt };
  }

  /** Returns the bound address on hit, null when the token is unknown or has
   *  expired. Tokens are 32 bytes of crypto.randomBytes, so a plain Map.get
   *  is safe: the lookup key *is* the secret. */
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

  /** Explicit logout. Idempotent — unknown tokens are silently dropped. */
  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  private purgeExpired(): void {
    const now = Date.now();
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;
    for (const [n, e] of this.nonces) {
      if (e.expiresAt <= now) this.nonces.delete(n);
    }
    for (const [t, e] of this.sessions) {
      if (e.expiresAt <= now) this.sessions.delete(t);
    }
  }
}

/** Canonical challenge message. The client must produce **exactly** this
 *  string for the recovered signature to match. ASCII + LF so a copy/paste
 *  through any wallet UI doesn't mutate the bytes. The `Issued At` line ties
 *  the message to a wall-clock moment so an out-of-band capture loses meaning
 *  once the nonce expires. */
export function formatChallengeMessage(input: {
  nonce: string;
  issuedAt: string;
  domain?: string;
}): string {
  const domain = input.domain ?? "zkscatter shared-orderbook admin";
  return [
    `${domain} wants you to sign in to review KYC submissions.`,
    "",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}
