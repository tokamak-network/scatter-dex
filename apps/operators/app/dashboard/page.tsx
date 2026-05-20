"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Stat } from "../components/Stat";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { SectionHeader } from "../components/SectionHeader";
import { AdminConnectBar } from "../components/AdminConnectBar";
import { formatIsoDate, formatRelative } from "../lib/format";
import { useOperator, type OperatorState } from "../lib/useOperator";
import { adminGet, type AdminAuth, readAdminAuth } from "../lib/adminApi";
import { formatEth } from "../lib/adminUi";

type Auth = AdminAuth | null;

import type { SettlementRow } from "../lib/adminTypes";

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
    setAuth(readAdminAuth());
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
        <AdminConnectBar
          auth={auth}
          onAuth={setAuth}
          title="Relayer connection"
          subtitle="Powers the live sections below. Cleared when this tab closes."
        />
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

interface BucketRow {
  bucketStart: number;
  settled: number;
  failed: number;
  avgGasEth: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

interface BucketsBody {
  buckets: BucketRow[];
  since: number;
  until: number;
  bucketMs: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function LiveSections({ auth }: { auth: NonNullable<Auth> }) {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [recent, setRecent] = useState<SettlementRow[] | null>(null);
  const [feeTotals, setFeeTotals] = useState<FeeTotals | null>(null);
  const [perf, setPerf] = useState<BucketsBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const since = Date.now() - ONE_DAY_MS;
      const perfSince = Date.now() - SEVEN_DAYS_MS;
      const [s, h, f, p] = await Promise.all([
        adminGet<StatusBody>(auth, "/api/admin/status"),
        adminGet<{ rows: SettlementRow[] }>(
          auth,
          `/api/admin/history?limit=200`,
        ),
        adminGet<FeeTotals>(auth, `/api/admin/history/fees?since=${since}`),
        adminGet<BucketsBody>(
          auth,
          `/api/admin/history/buckets?since=${perfSince}&bucketMs=${60 * 60 * 1000}`,
        ),
      ]);
      setStatus(s);
      setRecent(h.rows);
      setFeeTotals(f);
      setPerf(p);
      setRefreshedAt(Date.now());
    } catch (e) {
      // Type-narrow before reading .message so a non-Error thrown
      // value (e.g. a string from a misbehaving fetch wrapper)
      // still produces a useful banner.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[dashboard] refresh failed", e);
      setError(msg);
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

      <PerformanceSection perf={perf} />

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

function PerformanceSection({ perf }: { perf: BucketsBody | null }) {
  if (!perf) {
    return (
      <section>
        <SectionHeader
          title="Performance (last 7d)"
          badge="live"
          hint="Hourly settlement throughput + p50/p95/p99 latency."
        />
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      </section>
    );
  }

  const totals = perf.buckets.reduce(
    (acc, b) => ({
      settled: acc.settled + b.settled,
      failed: acc.failed + b.failed,
    }),
    { settled: 0, failed: 0 },
  );
  const allDurations: number[] = [];
  for (const b of perf.buckets) {
    if (b.p50Ms != null) allDurations.push(b.p50Ms);
  }
  // For window-wide rollup, recompute percentiles across the
  // bucket-level p50s — gives a coarse "median of medians" view
  // that's still operator-meaningful at this aggregation level.
  // Bucket-level p95 / p99 are the more precise per-window signal.
  const windowP95s: number[] = perf.buckets
    .map((b) => b.p95Ms)
    .filter((v): v is number => v != null);

  return (
    <section>
      <SectionHeader
        title="Performance (last 7d)"
        badge="live"
        hint="Hourly settlement throughput + p50/p95/p99 latency from settlement_history."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="7d settled"
          value={String(totals.settled)}
          sub={`${totals.failed} failed`}
        />
        <Stat
          label="Window p50 latency"
          value={
            allDurations.length > 0
              ? `${Math.round(percentileLocal(allDurations, 50))} ms`
              : "—"
          }
          sub="median of hourly p50s"
        />
        <Stat
          label="Window p95 latency"
          value={
            windowP95s.length > 0
              ? `${Math.round(percentileLocal(windowP95s, 95))} ms`
              : "—"
          }
          sub="across hourly buckets"
        />
        <Stat
          label="Buckets w/ activity"
          value={`${perf.buckets.filter((b) => b.settled + b.failed > 0).length} of ${perf.buckets.length}`}
          sub={`hour buckets in 7d window`}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <ChartCard title="Hourly settled (count)">
          <BarChart
            data={perf.buckets.map((b) => ({
              start: b.bucketStart,
              value: b.settled,
              second: b.failed,
            }))}
          />
        </ChartCard>
        <ChartCard title="Hourly p95 latency (ms)">
          <BarChart
            // Pass null through for buckets with no measured
            // duration_ms — BarChart renders a gap rather than a
            // misleading "0 ms" bar / tooltip.
            data={perf.buckets.map((b) => ({
              start: b.bucketStart,
              value: b.p95Ms,
            }))}
            tone="latency"
          />
        </ChartCard>
      </div>
    </section>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
        {title}
      </div>
      {children}
    </div>
  );
}

interface Bar {
  start: number;
  /** null → render as a gap (no bar, "no data" tooltip). 0 → render
   *  a zero-height rect that still hovers cleanly. */
  value: number | null;
  /** Optional secondary value rendered as an amber overlay on top
   *  of the primary bar — used to surface failed counts inside the
   *  settled chart without doubling the number of charts. */
  second?: number;
}

function BarChart({
  data,
  tone,
}: {
  data: Bar[];
  tone?: "latency";
}) {
  const max = Math.max(
    1,
    ...data.map((d) => (d.value ?? 0) + (d.second ?? 0)),
  );
  const W = 480;
  const H = 100;
  const barW = data.length > 0 ? W / data.length : 0;
  const primary = tone === "latency" ? "var(--color-primary)" : "var(--color-success)";
  const secondary = "var(--color-warning)";

  return (
    <svg
      viewBox={`0 0 ${W} ${H + 20}`}
      preserveAspectRatio="none"
      className="h-32 w-full"
      role="img"
      aria-label="Hourly bucket chart"
    >
      {data.map((d, i) => {
        const x = i * barW;
        if (d.value === null) {
          // Faint dashed marker so a "no data" hour is visible but
          // not confusable with a real zero. Tooltip explains.
          return (
            <g key={d.start}>
              <line
                x1={x + barW * 0.5}
                x2={x + barW * 0.5}
                y1={H - 4}
                y2={H}
                stroke="var(--color-text-subtle)"
                strokeDasharray="2 2"
              >
                <title>{new Date(d.start).toLocaleString()} — no data</title>
              </line>
            </g>
          );
        }
        const totalH = (d.value / max) * H;
        const secondH = d.second ? (d.second / max) * H : 0;
        const primaryH = totalH;
        return (
          <g key={d.start}>
            <rect
              x={x + barW * 0.1}
              y={H - primaryH}
              width={barW * 0.8}
              height={primaryH}
              fill={primary}
              opacity={0.75}
            >
              <title>
                {new Date(d.start).toLocaleString()} — {d.value}
                {d.second != null ? ` settled / ${d.second} failed` : ""}
              </title>
            </rect>
            {secondH > 0 && (
              <rect
                x={x + barW * 0.1}
                y={H - secondH}
                width={barW * 0.8}
                height={secondH}
                fill={secondary}
                opacity={0.85}
              >
                <title>
                  {new Date(d.start).toLocaleString()} — {d.second} failed
                </title>
              </rect>
            )}
          </g>
        );
      })}
      <line
        x1={0}
        y1={H}
        x2={W}
        y2={H}
        stroke="var(--color-border)"
        strokeWidth={1}
      />
      <text
        x={2}
        y={H + 14}
        fontSize="9"
        fill="var(--color-text-subtle)"
      >
        {data[0] ? new Date(data[0].start).toLocaleDateString() : ""}
      </text>
      <text
        x={W - 2}
        y={H + 14}
        textAnchor="end"
        fontSize="9"
        fill="var(--color-text-subtle)"
      >
        now · max {Math.round(max)}
      </text>
    </svg>
  );
}

function percentileLocal(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
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


function formatUptime(uptimeSince: string | number): string {
  const ts = typeof uptimeSince === "number" ? uptimeSince : Date.parse(uptimeSince);
  if (!Number.isFinite(ts)) return "—";
  return formatRelative(ts);
}
