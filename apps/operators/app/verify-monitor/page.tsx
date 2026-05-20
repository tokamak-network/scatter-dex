"use client";

/**
 * `/verify-monitor` — observability surface for the Phase 2.5b
 * settlement verifier (shipped in PR #722 + PR #724).
 * `GET /api/admin/verify-stats` returns two things in one payload:
 *   - DB-derived backlog (`unverifiedCount`, `oldestUnverifiedBlock`) —
 *     authoritative, always populated.
 *   - In-process `VerifyMonitor` snapshot (`lastPass`, `totalPasses`) —
 *     only populated when the verifier loop happens to be running in
 *     the same Node process as the API server. The production wiring
 *     in `deploy/runtime/compose.yml` runs the verifier as a separate
 *     `settlement-verifier` service, so on those deployments the
 *     in-process monitor stays empty by design and the backlog card
 *     is the real signal.
 *
 * Operator workflow:
 *   1. Paste the orderbook URL + the same `ADMIN_TOKEN` configured on
 *      the orderbook.
 *   2. The page polls every 30 s (matching the verifier's default
 *      pass cadence) and renders the backlog + the last pass (when
 *      available).
 *   3. If `unverifiedCount` stays > 0 for hours, an alert tint flags
 *      it — likely an upstream issue (RPC down, wrong contract
 *      address, or a relayer pushing rows the chain never confirms).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchVerifyStats,
  readVerifyAuth,
  writeVerifyAuth,
  VerifyAuthError,
  VerifyDisabledError,
  type VerifyAuth,
  type VerifyStats,
} from "../lib/verifyMonitor";
import { formatRelative } from "../lib/format";
import { backlogTone, type BacklogTone } from "../lib/verifyMonitorStatus";

const POLL_INTERVAL_MS = 30_000;

export default function VerifyMonitorPage() {
  const [auth, setAuth] = useState<VerifyAuth | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAuth(readVerifyAuth());
    setHydrated(true);
  }, []);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Verify monitor</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Live read-out of the shared-orderbook&apos;s settlement-verifier
          service. Authenticates with the orderbook&apos;s{" "}
          <code className="font-mono">ADMIN_TOKEN</code> over a bearer
          header — credentials live in{" "}
          <code className="font-mono">sessionStorage</code> for this tab
          only.
        </p>
      </header>

      <ConnectBar auth={auth} onAuth={setAuth} />

      {hydrated && auth ? (
        <StatsCard auth={auth} />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Enter the orderbook URL and admin token above to start polling.
        </div>
      )}
    </div>
  );
}

function ConnectBar({
  auth,
  onAuth,
}: {
  auth: VerifyAuth | null;
  onAuth: (next: VerifyAuth | null) => void;
}) {
  const [url, setUrl] = useState(auth?.url ?? "");
  const [token, setToken] = useState(auth?.token ?? "");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    setUrl(auth?.url ?? "");
    setToken(auth?.token ?? "");
  }, [auth]);

  const onConnect = async () => {
    const trimmedUrl = url.trim();
    const trimmedToken = token.trim();
    if (!trimmedUrl || !trimmedToken) {
      setError("URL and admin token are both required.");
      return;
    }
    setError(null);
    setVerifying(true);
    try {
      // Probe-fetch so a wrong token is reported up-front, before we
      // commit it to sessionStorage and start polling.
      await fetchVerifyStats({ url: trimmedUrl, token: trimmedToken });
      const next = { url: trimmedUrl, token: trimmedToken };
      writeVerifyAuth(next);
      onAuth(next);
    } catch (err) {
      if (err instanceof VerifyAuthError) setError("Bearer token rejected.");
      else if (err instanceof VerifyDisabledError)
        setError("Orderbook admin endpoints are disabled (ADMIN_TOKEN unset on the server).");
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  };

  const onDisconnect = () => {
    writeVerifyAuth(null);
    onAuth(null);
    setUrl("");
    setToken("");
  };

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
        <input
          type="url"
          aria-label="Shared-orderbook URL"
          placeholder="https://orderbook.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={verifying || !!auth}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm"
        />
        <input
          type="password"
          aria-label="Orderbook admin token"
          placeholder="ADMIN_TOKEN"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={verifying || !!auth}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 font-mono text-sm"
        />
        {auth ? (
          <button
            onClick={onDisconnect}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm hover:bg-[var(--color-background)]"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={verifying}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {verifying ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
      {error ? (
        <p className="mt-3 text-xs text-[var(--color-danger,#c92a2a)]">{error}</p>
      ) : null}
    </section>
  );
}

function StatsCard({ auth }: { auth: VerifyAuth }) {
  const [stats, setStats] = useState<VerifyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const next = await fetchVerifyStats(auth, ac.signal);
      if (ac.signal.aborted) return;
      setStats(next);
      setError(null);
      setRefreshedAt(Date.now());
    } catch (err) {
      if (ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [auth]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      clearInterval(t);
      abortRef.current?.abort();
    };
  }, [poll]);

  if (!stats && !error) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="rounded-xl border border-[var(--color-danger,#c92a2a)] bg-[var(--color-surface)] p-6 text-sm">
        <strong className="text-[var(--color-danger,#c92a2a)]">Error:</strong>{" "}
        {error}
      </div>
    );
  }

  const s = stats!;
  const tone = backlogTone(s.unverifiedCount, s.lastPass?.finishedAt ?? null);
  const toneClass = backlogToneClass(tone);

  return (
    <section className="space-y-4">
      {error ? (
        <div className="rounded-md border border-[var(--color-danger,#c92a2a)] bg-[var(--color-surface)] p-3 text-xs">
          Last refresh failed: {error}
        </div>
      ) : null}

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Backlog</h2>
          <span className="text-xs text-[var(--color-text-muted)]">
            polled every 30 s
            {refreshedAt ? ` · refreshed ${formatRelative(refreshedAt)}` : ""}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Metric label="Unverified rows" value={String(s.unverifiedCount)} tone={toneClass} />
          <Metric
            label="Oldest unverified block"
            value={s.oldestUnverifiedBlock !== null ? String(s.oldestUnverifiedBlock) : "—"}
          />
          <Metric label="Total verifier passes (this server)" value={String(s.totalPasses)} />
        </div>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="text-lg font-semibold">Last pass</h2>
        {s.lastPass ? (
          <>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Finished {formatRelative(s.lastPass.finishedAt)} · scanned up to block{" "}
              {s.lastPass.maxBlock}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <Metric label="Scanned" value={String(s.lastPass.scanned)} />
              <Metric
                label="Flipped → verified"
                value={String(s.lastPass.flipped)}
                tone="text-[var(--color-success,#2f9e44)]"
              />
              <Metric label="Unmatched" value={String(s.lastPass.unmatched)} />
              <Metric
                label="Duration"
                value={`${Math.max(0, s.lastPass.finishedAt - s.lastPass.startedAt)} ms`}
              />
            </div>
            {s.lastPass.unmatched > 0 ? (
              <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                <UnmatchedReason label="no event" count={s.lastPass.unmatchedByReason["no-event"]} />
                <UnmatchedReason label="tx mismatch" count={s.lastPass.unmatchedByReason["tx-mismatch"]} />
                <UnmatchedReason label="relayer mismatch" count={s.lastPass.unmatchedByReason["relayer-mismatch"]} />
              </div>
            ) : null}
            {s.lastPass.error ? (
              <p className="mt-4 text-xs text-[var(--color-danger,#c92a2a)]">
                Pass error: <code className="font-mono">{s.lastPass.error}</code>
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            No pass observed yet on this orderbook server. The in-process
            monitor only sees passes the verifier daemon has run in this
            same Node process — when the verifier runs as a separate
            compose service (the production wiring), this card stays empty
            by design. Backlog above is still authoritative.
          </p>
        )}
      </div>
    </section>
  );
}

function backlogToneClass(tone: BacklogTone): string {
  if (tone === "ok") return "text-[var(--color-success,#2f9e44)]";
  if (tone === "stale") return "text-[var(--color-danger,#c92a2a)]";
  return "text-[var(--color-warning,#e67700)]";
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function UnmatchedReason({ label, count }: { label: string; count: number }) {
  if (count === 0) return null;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2">
      <div className="text-[var(--color-text-muted)]">{label}</div>
      <div className="font-mono text-base">{count}</div>
    </div>
  );
}
