"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import {
  requestSiweChallenge,
  submitSiweSession,
  writeAdminAuth,
  type AdminAuth,
} from "../lib/adminApi";

/**
 * URL + wallet-signature (or fallback admin-key) connect bar. The
 * wallet flow is preferred — it ties admin access to the operator's
 * RelayerRegistry record so a leaked key alone can't authenticate.
 * The legacy `x-admin-key` form stays exposed under a collapsed
 * "Use admin key" toggle for CI scripts and deploys that haven't yet
 * set `RELAYER_REGISTRY_ADDRESS` on the relayer.
 */
export function AdminConnectBar({
  auth,
  onAuth,
  title,
  subtitle,
}: {
  auth: AdminAuth | null;
  onAuth: (next: AdminAuth | null) => void;
  title?: string;
  subtitle?: string;
}) {
  const [url, setUrl] = useState(auth?.url ?? "");
  const [key, setKey] = useState(auth?.key ?? "");
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { signer, connect } = useWallet();

  // Reflect parent-driven auth changes (route nav re-reads sessionStorage).
  useEffect(() => {
    setUrl(auth?.url ?? "");
    setKey(auth?.key ?? "");
  }, [auth]);

  const connectedAsWallet = !!auth?.token;
  const connected = connectedAsWallet || !!auth?.key;

  // Common wrapper: validates URL, manages busy/error state, and
  // delegates the credential exchange to the caller. Returning the
  // built `AdminAuth` keeps each flow's body focused on its protocol
  // (signature vs key probe) rather than React bookkeeping.
  const runConnect = async (
    exchange: (url: string) => Promise<AdminAuth | null>,
  ) => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError("Relayer URL is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const next = await exchange(trimmedUrl);
      if (next) {
        writeAdminAuth(next);
        onAuth(next);
      }
    } catch (e) {
      setError((e as Error).message || "Connection failed.");
    } finally {
      setBusy(false);
    }
  };

  const onConnectWallet = () =>
    runConnect(async (trimmedUrl) => {
      // Mint the challenge first so a wrong URL or a relayer that
      // hasn't enabled wallet auth fails fast — no point prompting
      // the wallet if the server can't issue a session.
      const challenge = await requestSiweChallenge(trimmedUrl);
      // The shared `useWallet` hook owns provider detection and
      // late-injection retries. If `signer` is null, the operator
      // hasn't connected yet; `connect()` prompts them.
      const live = signer ?? (await (async () => {
        await connect();
        return signer;
      })());
      if (!live) {
        throw new Error(
          "Connect your wallet first, then try again. (Use the admin-key form if no wallet is available.)",
        );
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
      return {
        url: trimmedUrl,
        token: session.token,
        address: session.address,
        expiresAt: session.expiresAt,
      };
    });

  const onConnectKey = () =>
    runConnect(async (trimmedUrl) => {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        throw new Error("Admin key is required.");
      }
      // Verify the pair against /status before persisting so a typo
      // doesn't propagate into every page that reads sessionStorage.
      const target = new URL("/api/admin/status", trimmedUrl).toString();
      const res = await fetch(target, { headers: { "x-admin-key": trimmedKey } });
      if (res.status === 401 || res.status === 403) {
        throw new Error("Admin key rejected (401/403). Double-check the value.");
      }
      if (!res.ok) {
        throw new Error(`Relayer returned HTTP ${res.status}.`);
      }
      return { url: trimmedUrl, key: trimmedKey };
    });

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
            {connectedAsWallet && auth.address
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

      {!connected && (
        <>
          <button
            type="button"
            onClick={() => setShowKeyForm((v) => !v)}
            className="mt-3 text-xs text-[var(--color-text-muted)] underline hover:text-[var(--color-primary)]"
          >
            {showKeyForm ? "Hide admin-key form" : "Use admin key instead"}
          </button>
          {showKeyForm && (
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Admin API key"
                aria-label="Admin API key"
                className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={onConnectKey}
                disabled={busy || !url.trim() || !key.trim()}
                className="rounded-md border border-[var(--color-border-strong)] bg-white px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Verifying…" : "Connect with key"}
              </button>
            </div>
          )}
        </>
      )}

      {error ? (
        <p className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
