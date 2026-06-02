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
  account: string; // lowercase address this session was minted for
}

// Keyed by lowercase account so every component on the page shares one session
// per wallet AND switching wallets can't reuse a stale token (which would
// mis-attribute audit-log actions / reuse a prior admin's privileges). A single
// in-flight mint per account is de-duped so concurrent calls share one signature.
const sessions = new Map<string, Session>();
const mintingPromises = new Map<string, Promise<Session>>();

/** Re-mint this far before expiry so a request never races the TTL. */
const EXPIRY_SKEW_MS = 30_000;

interface Signer {
  signMessage(message: string): Promise<string>;
}

async function mintSession(orderbookUrl: string, signer: Signer, account: string): Promise<Session> {
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
  return { token, expiresAt, account: account.toLowerCase() };
}

async function ensureToken(orderbookUrl: string, signer: Signer, account: string): Promise<string> {
  const key = account.toLowerCase();
  const existing = sessions.get(key);
  if (existing && Date.now() < existing.expiresAt - EXPIRY_SKEW_MS) return existing.token;

  let minting = mintingPromises.get(key);
  if (!minting) {
    minting = mintSession(orderbookUrl, signer, account).finally(() => { mintingPromises.delete(key); });
    mintingPromises.set(key, minting);
  }
  const session = await minting;
  sessions.set(key, session);
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
      if (!signer || !account) throw new Error("Connect the admin wallet to authenticate.");
      const withAuth = (token: string): Promise<Response> => {
        // Use the Headers constructor so a caller's Headers/array/object init
        // all merge correctly (object spread would drop a Headers/array form).
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return fetch(url, { ...init, headers });
      };

      const key = account.toLowerCase();
      let res = await withAuth(await ensureToken(orderbookUrl, signer, account));
      if (res.status === 401) {
        // Token expired or revoked server-side — drop it and re-auth once.
        sessions.delete(key);
        res = await withAuth(await ensureToken(orderbookUrl, signer, account));
      }
      return res;
    },
    [orderbookUrl, signer, account],
  );

  return { account, connect, authedFetch };
}
