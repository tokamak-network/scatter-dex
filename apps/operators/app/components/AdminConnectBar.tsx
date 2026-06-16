"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import {
  readPersistedAdminUrl,
  requestSiweChallenge,
  submitSiweSession,
  writeAdminAuth,
  type AdminAuth,
} from "../lib/adminApi";

/**
 * URL + wallet-signature connect bar. Admin access is tied to the
 * operator's RelayerRegistry record via a SIWE challenge/session, so a
 * leaked key alone can't authenticate — the relayer no longer accepts
 * the legacy `x-admin-key` path, so wallet signing is the only flow.
 */
export function AdminConnectBar({
  auth,
  onAuth,
  title,
  subtitle,
  suggestedUrl,
}: {
  auth: AdminAuth | null;
  onAuth: (next: AdminAuth | null) => void;
  title?: string;
  subtitle?: string;
  /** On-chain registered URL for the connected operator. Used as the
   *  third-tier default when neither the active session nor the
   *  persisted last-used URL is populated, so a freshly-loaded
   *  dashboard doesn't ask the operator to retype their own URL. */
  suggestedUrl?: string;
}) {
  // Initial URL falls back to the persisted value even when `auth`
  // is null — sessions expire after 15 min and we don't want the
  // operator retyping the relayer URL every time they re-sign.
  // Suggested URL (from the on-chain registry row) is the third tier
  // so an operator who has never connected on this tab still gets a
  // prefill on first render.
  const [url, setUrl] = useState(
    () => auth?.url ?? readPersistedAdminUrl() ?? suggestedUrl ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { signer, connect } = useWallet();

  // Track the last-applied identity so a parent re-render that
  // passes a fresh-but-equal `auth` object, or an async-arriving
  // `suggestedUrl` from useOperator(), doesn't overwrite a value
  // the user just typed into the inputs.
  const lastAppliedAuthUrl = useRef<string | null>(auth?.url ?? null);
  const lastAppliedSuggested = useRef<string | undefined>(suggestedUrl);

  useEffect(() => {
    const nextAuthUrl = auth?.url ?? null;
    const authUrlChanged = nextAuthUrl !== lastAppliedAuthUrl.current;
    const suggestedChanged = suggestedUrl !== lastAppliedSuggested.current;
    if (!authUrlChanged && !suggestedChanged) return;
    lastAppliedAuthUrl.current = nextAuthUrl;
    lastAppliedSuggested.current = suggestedUrl;

    if (auth?.url) {
      // Active session: always reflect it. Wipes any stale free-text
      // because the user has committed to this URL by signing in.
      setUrl(auth.url);
      return;
    }

    // No active session (initial load, logout, or expired SIWE token).
    // Preserve a non-empty user edit so an async suggestedUrl arrival
    // can't blow it away; otherwise fall back through the intended
    // hierarchy: last-used persisted → on-chain registered → empty.
    setUrl((current) =>
      current.trim()
        ? current
        : readPersistedAdminUrl() ?? suggestedUrl ?? "",
    );
  }, [auth, suggestedUrl]);

  const connected = !!auth?.token;

  // Single connect flow: validate URL, run the SIWE handshake, persist
  // the session. Wallet signing is the only path, so the bookkeeping
  // (busy / error / writeAdminAuth) lives inline rather than behind a
  // higher-order wrapper.
  const onConnectWallet = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError("Relayer URL is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Mint the challenge first so a wrong URL or a relayer that
      // hasn't enabled wallet auth fails fast — no point prompting
      // the wallet if the server can't issue a session.
      const challenge = await requestSiweChallenge(trimmedUrl);
      // Resolve a live signer. `useWallet().signer` is the happy
      // path; if the operator hasn't connected this tab yet, we ask
      // the hook to prompt (`connect()`) and then read a fresh
      // signer directly from the injected provider — the hook's
      // React state won't have flushed back into this closure yet.
      let live = signer;
      if (!live) {
        const eth = (window as unknown as { ethereum?: ethers.Eip1193Provider })
          .ethereum;
        if (!eth) {
          throw new Error(
            "No browser wallet detected. Install MetaMask to connect.",
          );
        }
        await connect();
        live = await new ethers.BrowserProvider(eth).getSigner();
      }
      // Sign the EXACT server-provided message — recomputing it
      // client-side risks a one-byte drift (line endings, whitespace)
      // that would silently invalidate every session.
      const signature = await live.signMessage(challenge.message);
      const session = await submitSiweSession(trimmedUrl, {
        nonce: challenge.nonce,
        message: challenge.message,
        signature,
      });
      const next: AdminAuth = {
        url: trimmedUrl,
        token: session.token,
        address: session.address,
        expiresAt: session.expiresAt,
      };
      writeAdminAuth(next);
      onAuth(next);
    } catch (e) {
      setError((e as Error).message || "Connection failed.");
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    // Best-effort server-side revoke for the SIWE path. We swallow
    // failures — a stale session that the server already forgot
    // (process restart) shouldn't block the client-side logout.
    if (auth?.url && auth.token) {
      try {
        await fetch(new URL("/api/admin/session/revoke", auth.url).toString(), {
          method: "POST",
          headers: { Authorization: `Bearer ${auth.token}` },
        });
      } catch {
        // ignored — proceed with local cleanup
      }
    }
    writeAdminAuth(null);
    onAuth(null);
  };

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{title ?? "Connection"}</h2>
          {subtitle && (
            <p className="text-xs text-[var(--color-text-muted)]">{subtitle}</p>
          )}
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-[var(--color-success-soft)] px-3 py-1 text-xs font-medium text-[var(--color-success)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
            {auth?.address
              ? `Connected · ${auth.address.slice(0, 6)}…${auth.address.slice(-4)}`
              : "Connected"}
          </span>
        ) : null}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://relayer.example.com"
          aria-label="Relayer URL"
          disabled={connected}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono disabled:cursor-not-allowed disabled:bg-[var(--color-bg)]"
        />
        {connected ? (
          <button
            onClick={onDisconnect}
            className="rounded-md border border-[var(--color-border-strong)] bg-white px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg)]"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnectWallet}
            disabled={busy || !url.trim()}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Connect wallet"}
          </button>
        )}
      </div>

      {error ? (
        <p className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
