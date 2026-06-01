/**
 * Wallet-signature (SIWE-style) admin auth — shared core.
 *
 * Used by the Node backends (`zk-relayer`, `shared-orderbook`) to gate
 * operator/admin endpoints behind an admin wallet signature. The two services
 * differ only in how they decide "is this signer an admin" (an injected
 * `verifyAdmin` probe — an on-chain registry read, or a static allowlist) and
 * in the challenge message's domain/action text; everything else (nonce +
 * session lifecycle, single-use nonces, exact-message match) is identical and
 * lives here.
 *
 * Server-only: uses `node:crypto` for randomness. Not for browser bundles.
 *
 * Flow:
 *   1. Client GETs a challenge → fresh nonce (single-use, 60s TTL) + the exact
 *      message to sign.
 *   2. Client signs that message with the admin wallet and posts
 *      { nonce, message, signature }.
 *   3. Server recovers the signer (ethers), checks `verifyAdmin`, and on
 *      success mints a session token (15-min TTL) for `Authorization: Bearer`.
 *
 * The nonce + session stores are in-memory — a restart invalidates active
 * sessions (re-sign takes seconds; single process).
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

const DEFAULT_DOMAIN = "zkscatter admin";
const DEFAULT_ACTION = "sign in";

interface NonceEntry {
  expiresAt: number;
  /** Exact challenge message bound to this nonce. The client must present the
   *  byte-identical string back in `createSession` — this prevents an attacker
   *  from getting an admin to sign an innocuous-looking message that merely
   *  contains the nonce somewhere in its body. */
  message: string;
}

interface SessionEntry {
  address: string;
  expiresAt: number;
}

/** Per-instance challenge message wording. Both services keep their original
 *  text by passing these through. */
export interface AdminSiweMessageOptions {
  /** Leading domain phrase, e.g. "zkscatter operators admin". */
  domain?: string;
  /** Action phrase after "wants you to ", e.g. "sign in to manage this relayer". */
  action?: string;
  /** Error message thrown when the recovered signer fails the `verifyAdmin`
   *  probe. Each service keeps its own wording (e.g. "not an active relayer in
   *  the registry" vs "not an authorized admin") so the UI can stay specific. */
  notAdminError?: string;
}

const DEFAULT_NOT_ADMIN_ERROR = "Signer is not an authorized admin";

/** Issues challenges, verifies signatures, and tracks live sessions. Built
 *  once per process; routes use `issueChallenge`, `createSession`,
 *  `verifySession`, and `revokeSession` to drive the flow.
 *
 *  `verifyAdmin` is positional (kept backward-compatible with the original
 *  per-service classes); message wording is an optional second argument. */
export class AdminSiweAuth {
  private nonces = new Map<string, NonceEntry>();
  private sessions = new Map<string, SessionEntry>();
  private lastPurgeAt = 0;
  private readonly domain: string;
  private readonly action: string;
  private readonly notAdminError: string;

  constructor(
    private verifyAdmin: (address: string) => boolean | Promise<boolean>,
    options: AdminSiweMessageOptions = {},
  ) {
    this.domain = options.domain ?? DEFAULT_DOMAIN;
    this.action = options.action ?? DEFAULT_ACTION;
    this.notAdminError = options.notAdminError ?? DEFAULT_NOT_ADMIN_ERROR;
  }

  /** Reserve a fresh nonce and the canonical message that must be signed
   *  against it. Caller consumes it via `createSession` before NONCE_TTL_MS. */
  issueChallenge(): { nonce: string; expiresAt: number; issuedAt: string; message: string } {
    this.purgeExpired();
    const nonce = randomBytes(NONCE_BYTES).toString("hex");
    const expiresAt = Date.now() + NONCE_TTL_MS;
    const issuedAt = new Date().toISOString();
    const message = formatChallengeMessage({ nonce, issuedAt, domain: this.domain, action: this.action });
    this.nonces.set(nonce, { expiresAt, message });
    return { nonce, expiresAt, issuedAt, message };
  }

  /** Verify the signature, ensure the signer is an admin, and mint a session
   *  token. The nonce is consumed on success **and** on signature-mismatch —
   *  anything that proves the client saw it (or tried) burns the slot, so
   *  replay windows stay tight. */
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
    // against the same nonce while the admin re-signs. The client retries with
    // a fresh challenge.
    this.nonces.delete(nonce);
    if (entry.expiresAt <= Date.now()) {
      throw new Error("Challenge nonce expired");
    }
    // Exact-match against the message issued *with this nonce*. A permissive
    // `includes(nonce)` check would let an attacker craft an innocuous message
    // containing the nonce and trick an admin into signing it.
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
      throw new Error(this.notAdminError);
    }
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { address: recovered.toLowerCase(), expiresAt });
    return { token, address: recovered, expiresAt };
  }

  /** Returns the bound address on hit, null when the token is unknown or has
   *  expired. Tokens are 32 bytes of crypto.randomBytes, so a plain Map.get is
   *  safe: the lookup key *is* the secret. */
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

/** Canonical challenge message. The client must produce **exactly** this string
 *  for the recovered signature to match. ASCII + LF so a copy/paste through any
 *  wallet UI doesn't mutate the bytes. The `Issued At` line ties the message to
 *  a wall-clock moment so an out-of-band capture loses meaning once the nonce
 *  expires. */
export function formatChallengeMessage(input: {
  nonce: string;
  issuedAt: string;
  domain?: string;
  action?: string;
}): string {
  const domain = input.domain ?? DEFAULT_DOMAIN;
  const action = input.action ?? DEFAULT_ACTION;
  return [
    `${domain} wants you to ${action}.`,
    "",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}
