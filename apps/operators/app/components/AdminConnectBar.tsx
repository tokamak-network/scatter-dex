"use client";

import { useEffect, useState } from "react";
import {
  ADMIN_SS_KEY,
  ADMIN_SS_URL,
  type AdminAuth,
} from "../lib/adminApi";

/**
 * URL + admin-key form that verifies via `GET /api/admin/status`
 * before persisting the pair in sessionStorage. Used by every page
 * that needs to call relayer admin endpoints (`/runtime`,
 * `/dashboard`, with `/orders`, `/orders/detail`, `/treasury`
 * sharing the cached pair). Connecting on any one of them lights
 * up the rest for the tab session.
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
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Keep the form in sync when the auth prop changes (e.g. the
  // parent re-read sessionStorage after navigating between routes
  // in this tab — sessionStorage is per-tab, not cross-tab).
  useEffect(() => {
    setUrl(auth?.url ?? "");
    setKey(auth?.key ?? "");
  }, [auth]);

  const onConnect = async () => {
    const trimmedUrl = url.trim();
    const trimmedKey = key.trim();
    if (!trimmedUrl || !trimmedKey) {
      setError("URL and admin key are both required.");
      return;
    }
    setError(null);
    setVerifying(true);
    try {
      const target = new URL("/api/admin/status", trimmedUrl).toString();
      const res = await fetch(target, {
        headers: { "x-admin-key": trimmedKey },
      });
      if (res.status === 401 || res.status === 403) {
        setError("Admin key rejected (401/403). Double-check the value.");
        return;
      }
      if (!res.ok) {
        setError(`Relayer returned HTTP ${res.status}.`);
        return;
      }
      sessionStorage.setItem(ADMIN_SS_URL, trimmedUrl);
      sessionStorage.setItem(ADMIN_SS_KEY, trimmedKey);
      onAuth({ url: trimmedUrl, key: trimmedKey });
    } catch (e) {
      setError(`Could not reach the URL: ${(e as Error).message}`);
    } finally {
      setVerifying(false);
    }
  };

  const onDisconnect = () => {
    sessionStorage.removeItem(ADMIN_SS_URL);
    sessionStorage.removeItem(ADMIN_SS_KEY);
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
        {auth ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-[var(--color-success-soft)] px-3 py-1 text-xs font-medium text-[var(--color-success)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
            Connected
          </span>
        ) : null}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[2fr_2fr_auto]">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://relayer.example.com"
          aria-label="Relayer URL"
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
        />
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Admin API key"
          aria-label="Admin API key"
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
        />
        {auth ? (
          <button
            onClick={onDisconnect}
            className="rounded-md border border-[var(--color-border-strong)] bg-white px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg)]"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={verifying || !url.trim() || !key.trim()}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {verifying ? "Verifying…" : "Connect"}
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
