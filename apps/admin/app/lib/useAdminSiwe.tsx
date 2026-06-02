"use client";

import { useCallback } from "react";
import { useWallet } from "@zkscatter/sdk/react";

/** Admin wallet-signature (SIWE) auth for the shared-orderbook admin API.
 *
 *  Flow (shared-orderbook routes/admin.ts + @scatter-dex/types AdminSiweAuth):
 *    1. GET  /api/admin/challenge  → { nonce, message, expiresAt } (nonce 60s)
 *    2. wallet signs the EXACT message
 *    3. POST /api/admin/session    → { token, expiresAt } (session 15m)
 *    4. call admin endpoints with `Authorization: Bearer <token>`
 *
 *  The session token is held IN MEMORY only (module scope, shared across hook
 *  instances on the page). It is deliberately NOT persisted: persisting it to
 *  localStorage/sessionStorage would recreate the very XSS exposure surface
 *  that retiring the static ADMIN_TOKEN removed. A refresh re-signs — admin KYC
 *  review is low-frequency, so the re-sign cost is acceptable. */

interface Session {
  token: string;
  expiresAt: number; // unix ms
}

// Module-level so every component on the page shares one session, and a single
// in-flight mint is de-duped (concurrent calls don't each pop a signature).
let session: Session | null = null;
let minting: Promise<Session> | null = null;

/** Re-mint this far before expiry so a request never races the TTL. */
const EXPIRY_SKEW_MS = 30_000;

interface Signer {
  signMessage(message: string): Promise<string>;
}

async function mintSession(orderbookUrl: string, signer: Signer): Promise<Session> {
  const chRes = await fetch(`${orderbookUrl}/api/admin/challenge`);
  if (!chRes.ok) throw new Error(`Admin challenge failed (${chRes.status})`);
  const { nonce, message } = (await chRes.json()) as { nonce: string; message: string };

  const signature = await signer.signMessage(message);

  const sesRes = await fetch(`${orderbookUrl}/api/admin/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, message, signature }),
  });
  if (!sesRes.ok) {
    const j = (await sesRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Admin session failed (${j.error ?? sesRes.status}). Is this wallet an admin?`);
  }
  const { token, expiresAt } = (await sesRes.json()) as { token: string; expiresAt: number };
  return { token, expiresAt };
}

async function ensureToken(orderbookUrl: string, signer: Signer): Promise<string> {
  if (session && Date.now() < session.expiresAt - EXPIRY_SKEW_MS) return session.token;
  if (!minting) {
    minting = mintSession(orderbookUrl, signer).finally(() => { minting = null; });
  }
  session = await minting;
  return session.token;
}

export interface UseAdminSiwe {
  /** Connected wallet address, or null. The connected wallet must be on the
   *  orderbook's ADMIN_ADDRESSES allowlist for the session mint to succeed. */
  account: string | null;
  connect: () => Promise<void>;
  /** fetch() that transparently mints/refreshes a SIWE session and attaches
   *  `Authorization: Bearer`. On a 401 it drops the cached token and re-auths
   *  once (the token may have expired server-side). Throws if no wallet is
   *  connected — the caller should prompt connect when `account` is null. */
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function useAdminSiwe(orderbookUrl: string): UseAdminSiwe {
  const { account, signer, connect } = useWallet();

  const authedFetch = useCallback(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (!signer) throw new Error("Connect the admin wallet to authenticate.");
      const withAuth = (token: string): Promise<Response> =>
        fetch(url, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });

      let res = await withAuth(await ensureToken(orderbookUrl, signer));
      if (res.status === 401) {
        // Token expired or revoked server-side — drop it and re-auth once.
        session = null;
        res = await withAuth(await ensureToken(orderbookUrl, signer));
      }
      return res;
    },
    [orderbookUrl, signer],
  );

  return { account, connect, authedFetch };
}
