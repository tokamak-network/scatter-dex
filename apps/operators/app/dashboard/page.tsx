"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Stat } from "../components/Stat";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { SectionHeader } from "../components/SectionHeader";
import { formatIsoDate, formatRelative } from "../lib/format";
import { useOperator, type OperatorState } from "../lib/useOperator";

// Reuse the same sessionStorage keys as /runtime so the operator
// only authenticates once per tab.
const SS_URL = "operators-admin-url";
const SS_KEY = "operators-admin-key";

type Auth = { url: string; key: string } | null;

interface SettlementRow {
  id: number;
  tx_hash: string;
  type: "settleAuth" | "scatterDirectAuth";
  status: "confirmed" | "failed";
  block_number: number | null;
  gas_cost_eth: string | null;
  sell_token: string | null;
  buy_token: string | null;
  error_reason: string | null;
  created_at: number;
}

interface FeeTotals {
  totals: Array<{ token: string; count: number; totalWei: string }>;
}

interface StatusBody {
  paused: boolean;
  feeBps: number;
  ethBalance: string;
  pendingTxs: number;
  authorizeOrders: { pending: number; matched: number; total: number };
  stats: { uptimeSince?: string | number };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export default function Dashboard() {
  const operator = useOperator();
  const [auth, setAuth] = useState<Auth>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const url = sessionStorage.getItem(SS_URL);
    const key = sessionStorage.getItem(SS_KEY);
    if (url && key) setAuth({ url, key });
    setHydrated(true);
  }, []);

  return (
    <div className="space-y-10">
      <OperatorIdentityBar />
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Operator dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Live view of fills, fee revenue, and node health.
          </p>
        </div>
        <Link
          href="/orders"
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          View live orders →
        </Link>
      </section>

      <section>
        <SectionHeader title="On-chain" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <BondCard operator={operator} />
          <FeeCard operator={operator} />
          <RegisteredCard operator={operator} />
        </div>
      </section>

      {hydrated && (
        <AdminConnectBar auth={auth} onAuth={setAuth} />
      )}

      {auth ? (
        <LiveSections auth={auth} />
      ) : (
        <section className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Connect your relayer above to see settlement history, fee accrual,
          and runtime status. Auth is shared with{" "}
          <Link href="/runtime" className="text-[var(--color-primary)] underline">
            /runtime
          </Link>{" "}
          via this tab&apos;s sessionStorage.
        </section>
      )}
    </div>
  );
}

function AdminConnectBar({
  auth,
  onAuth,
}: {
  auth: Auth;
  onAuth: (next: Auth) => void;
}) {
  const [url, setUrl] = useState(auth?.url ?? "");
  const [key, setKey] = useState(auth?.key ?? "");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

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
      const res = await fetch(target, { headers: { "x-admin-key": trimmedKey } });
      if (res.status === 401 || res.status === 403) {
        setError("Admin key rejected (401/403).");
        return;
      }
      if (!res.ok) {
        setError(`Relayer returned HTTP ${res.status}.`);
        return;
      }
      sessionStorage.setItem(SS_URL, trimmedUrl);
      sessionStorage.setItem(SS_KEY, trimmedKey);
      onAuth({ url: trimmedUrl, key: trimmedKey });
    } catch (e) {
      setError(`Could not reach the URL: ${(e as Error).message}`);
    } finally {
      setVerifying(false);
    }
  };

  const onDisconnect = () => {
    sessionStorage.removeItem(SS_URL);
    sessionStorage.removeItem(SS_KEY);
    onAuth(null);
  };

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Relayer connection</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Powers the live sections below. Cleared when this tab closes.
          </p>
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
            disabled={verifying || !url || !key}
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

function LiveSections({ auth }: { auth: NonNullable<Auth> }) {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [recent, setRecent] = useState<SettlementRow[] | null>(null);
  const [feeTotals, setFeeTotals] = useState<FeeTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const since = Date.now() - ONE_DAY_MS;
      const [s, h, f] = await Promise.all([
        adminGet<StatusBody>(auth, "/api/admin/status"),
        adminGet<{ rows: SettlementRow[] }>(
          auth,
          `/api/admin/history?limit=200`,
        ),
        adminGet<FeeTotals>(auth, `/api/admin/history/fees?since=${since}`),
      ]);
      setStatus(s);
      setRecent(h.rows);
      setFeeTotals(f);
      setRefreshedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [auth]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-5 text-sm text-[var(--color-warning)]">
        Failed to load dashboard data: {error}
      </section>
    );
  }

  const last24h = (recent ?? []).filter(
    (r) => Date.now() - r.created_at < ONE_DAY_MS,
  );
  const confirmed24h = last24h.filter((r) => r.status === "confirmed");
  const settled24h = confirmed24h.length;
  // Sum gas only over confirmed rows so the divisor (settled24h)
  // matches the numerator. Failed rows can still carry a non-null
  // gas_cost_eth, which would otherwise inflate the displayed mean.
  const totalGasEth = confirmed24h.reduce((acc, r) => {
    const v = parseFloat(r.gas_cost_eth ?? "0");
    return Number.isFinite(v) ? acc + v : acc;
  }, 0);
  const avgGasEth = settled24h > 0 ? totalGasEth / settled24h : 0;
  const newest = recent?.[0];

  return (
    <>
      <div className="flex items-center justify-end gap-3 text-xs text-[var(--color-text-muted)]">
        {refreshedAt && (
          <span>Refreshed {formatRelative(refreshedAt)}</span>
        )}
        <button
          onClick={refresh}
          disabled={refreshing}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <section>
        <SectionHeader
          title="Operations (24h)"
          badge="live"
          hint="Computed from settlement_history rows in the last 24 hours."
        />
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Settled (24h)"
            value={recent ? String(settled24h) : "…"}
            sub={
              recent
                ? `of ${last24h.length} attempts (${last24h.length - settled24h} failed)`
                : "Loading…"
            }
          />
          <Stat
            label="Avg gas / settle"
            value={recent ? `${avgGasEth.toFixed(5)} ETH` : "…"}
            sub={settled24h > 0 ? "Mean across confirmed txs" : "No settles yet"}
          />
          <Stat
            label="Pending in queue"
            value={status ? String(status.authorizeOrders.pending) : "…"}
            sub={
              status
                ? `${status.authorizeOrders.total} ever, ${status.pendingTxs} txs in flight`
                : "Loading…"
            }
          />
        </div>
      </section>

      <section>
        <SectionHeader title="Fee accrual (24h)" badge="live" />
        {!feeTotals ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : feeTotals.totals.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No fees accrued in the last 24 hours.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">Token</th>
                  <th className="px-5 py-3 text-right font-medium">Fills</th>
                  <th className="px-5 py-3 text-right font-medium">Total (wei)</th>
                </tr>
              </thead>
              <tbody>
                {feeTotals.totals.map((t) => (
                  <tr key={t.token} className="border-t border-[var(--color-border)]">
                    <td className="px-5 py-3 font-mono text-xs">{t.token}</td>
                    <td className="px-5 py-3 text-right font-mono">{t.count}</td>
                    <td className="px-5 py-3 text-right font-mono">{t.totalWei}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="Health" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <HealthCard
            label="Relayer state"
            value={status ? (status.paused ? "Paused" : "Running") : "…"}
            tone={status?.paused ? "warning" : "success"}
            sub={
              status?.stats.uptimeSince
                ? `Up since ${formatUptime(status.stats.uptimeSince)}`
                : "—"
            }
          />
          <HealthCard
            label="ETH balance"
            value={status ? `${formatEth(status.ethBalance)} ETH` : "…"}
            tone="success"
            sub={status ? `Fee ${status.feeBps} bps` : "—"}
          />
          <HealthCard
            label="Last settlement"
            value={newest ? formatRelative(newest.created_at) : "Never"}
            tone={newest ? "success" : "warning"}
            sub={
              newest
                ? `Block ${newest.block_number ?? "?"} · ${newest.type}`
                : "No settlements recorded"
            }
          />
        </div>
      </section>

      <section>
        <SectionHeader
          title="Recent settlements"
          badge="live"
          hint="From settlement_history."
        />
        {!recent ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No settlements yet — once you start accepting orders they will
            show up here.
          </p>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {recent.slice(0, 10).map((s) => (
              <div
                key={s.tx_hash}
                className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0"
              >
                <div>
                  <div className="font-medium">
                    {s.type}{" "}
                    <span
                      className={`ml-2 inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        s.status === "confirmed"
                          ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                          : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-[var(--color-text-muted)]">
                    {s.tx_hash}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm">
                    {s.gas_cost_eth ? `${s.gas_cost_eth} ETH` : "—"}
                  </div>
                  <div className="text-xs text-[var(--color-text-subtle)]">
                    {formatRelative(s.created_at)} · block {s.block_number ?? "?"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function operatorPlaceholder(state: OperatorState): { value: string; sub: string } | null {
  if (!state.account) return { value: "—", sub: "Connect wallet to load" };
  if (!state.registryDeployed) return { value: "—", sub: "Registry not deployed" };
  if (state.loading) return { value: "…", sub: "Reading registry" };
  if (state.error) return { value: "—", sub: `Read error: ${state.error}` };
  if (!state.row || state.row.status === "unregistered") {
    return { value: "—", sub: "Not registered yet" };
  }
  return null;
}

function BondCard({ operator }: { operator: OperatorState }) {
  const ph = operatorPlaceholder(operator);
  if (ph) return <Stat label="Bond posted" value={ph.value} sub={ph.sub} />;
  const row = operator.row!;
  return <Stat label="Bond posted" value={`${row.bondEth} ETH`} sub={`Status: ${row.status}`} />;
}

function FeeCard({ operator }: { operator: OperatorState }) {
  const ph = operatorPlaceholder(operator);
  if (ph) return <Stat label="Per-trade fee" value={ph.value} sub={ph.sub} />;
  const row = operator.row!;
  return <Stat label="Per-trade fee" value={`${row.feeBps} bps`} sub={`= ${(row.feeBps / 100).toFixed(2)}% per fill`} />;
}

function RegisteredCard({ operator }: { operator: OperatorState }) {
  const ph = operatorPlaceholder(operator);
  if (ph) return <Stat label="Registered" value={ph.value} sub={ph.sub} />;
  const row = operator.row!;
  const value = formatIsoDate(row.registeredAt);
  const ageDays = Math.floor((Date.now() - row.registeredAt * 1000) / (1000 * 60 * 60 * 24));
  const sub =
    row.exitRequestedAt > 0
      ? `Exit requested ${formatIsoDate(row.exitRequestedAt)}`
      : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`;
  return <Stat label="Registered" value={value} sub={sub} />;
}

function HealthCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger";
  sub: string;
}) {
  const dot = {
    success: "bg-[var(--color-success)]",
    warning: "bg-[var(--color-warning)]",
    danger: "bg-[var(--color-danger)]",
  }[tone];
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-base font-semibold">{value}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}

async function adminGet<T>(auth: NonNullable<Auth>, path: string): Promise<T> {
  const target = new URL(path, auth.url).toString();
  const res = await fetch(target, { headers: { "x-admin-key": auth.key } });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const errField =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error: unknown }).error
        : undefined;
    const formatted =
      errField === undefined
        ? text
          ? text.slice(0, 120)
          : `HTTP ${res.status}`
        : typeof errField === "string"
        ? errField
        : JSON.stringify(errField);
    throw new Error(formatted);
  }
  return (parsed ?? ({} as unknown)) as T;
}

function formatEth(weiStr: string): string {
  try {
    const wei = BigInt(weiStr);
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n) / 10n ** 14n;
    return `${whole}.${frac.toString().padStart(4, "0")}`;
  } catch {
    return weiStr;
  }
}

function formatUptime(uptimeSince: string | number): string {
  const ts = typeof uptimeSince === "number" ? uptimeSince : Date.parse(uptimeSince);
  if (!Number.isFinite(ts)) return "—";
  return formatRelative(ts);
}
