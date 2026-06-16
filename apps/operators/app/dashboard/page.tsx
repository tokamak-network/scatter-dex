"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Stat } from "../components/Stat";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { SectionHeader } from "../components/SectionHeader";
import { AdminConnectBar } from "../components/AdminConnectBar";
import { formatIsoDate, formatRelative } from "../lib/format";
import { useOperator, type OperatorState } from "../lib/useOperator";
import {
  formatUptime,
  operatorPlaceholder,
  percentileLocal,
} from "../lib/dashboardHelpers";
import { adminGet, type AdminAuth, readAdminAuth } from "../lib/adminApi";
import { formatEth } from "../lib/adminUi";
import {
  RevenueCard,
  VolumeCard,
  type FeeTotal,
  type VolumeTotal,
} from "../components/PerTokenCards";
import { formatAmount } from "../lib/tokenRegistry";
import {
  TokenResolverProvider,
  useResolveToken,
  useTokenResolver,
} from "../lib/useTokenResolver";
import { usePlatformFeeBps, netAfterPlatformFee } from "../lib/usePlatformFeeBps";

type Auth = AdminAuth | null;

import type { SettlementRow } from "../lib/adminTypes";

interface FeeTotals {
  totals: FeeTotal[];
}

interface VolumeTotals {
  totals: VolumeTotal[];
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
        <div className="flex items-center gap-3">
          <Link
            href="/analytics"
            className="rounded-lg border border-[var(--color-border-strong)] px-4 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)]"
          >
            Analytics →
          </Link>
          <Link
            href="/orders"
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            View live orders →
          </Link>
        </div>
      </section>

      <section>
        <SectionHeader title="On-chain" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <BondCard operator={operator} />
          <FeeCard operator={operator} />
          <RegisteredCard operator={operator} />
        </div>
      </section>

      <PublicEndpointCard url={operator.row?.url} loading={operator.loading} />

      {hydrated && (
        <AdminConnectBar
          auth={auth}
          onAuth={setAuth}
          title="Relayer connection"
          subtitle="Powers the live sections below. Cleared when this tab closes."
          suggestedUrl={operator.row?.url}
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

/** Surfaces the operator's on-chain registered relayer endpoint —
 *  the URL the wider network (other relayers, the Pro/Pay clients
 *  picking a relayer) will hit. Operators kept asking "how do my
 *  users connect?" while the answer was already on-chain via
 *  `RelayerRegistry.operators(addr).url`; this card lifts it into
 *  plain sight with a one-click copy. */
function PublicEndpointCard({
  url,
  loading,
}: {
  url: string | undefined;
  loading?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Auto-clear the "Copied" pill with cleanup so navigating away
  // mid-timeout doesn't trigger a setState on an unmounted card.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const trimmed = url?.trim();
  if (!trimmed) {
    // Skip the "Not set on-chain" call-to-action while the registry
    // row is still in flight — flashing a "go publish a URL" prompt
    // before the row resolves is jarring and frequently wrong.
    if (loading) {
      return (
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
          <div className="font-semibold text-[var(--color-text)]">Public endpoint</div>
          <p className="mt-1">Loading on-chain endpoint…</p>
        </section>
      );
    }
    return (
      <section className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
        <div className="font-semibold text-[var(--color-text)]">Public endpoint</div>
        <p className="mt-1">
          Not set on-chain. Open{" "}
          <Link href="/profile" className="text-[var(--color-primary)] underline">
            /profile
          </Link>{" "}
          to publish a URL so peers and clients can route orders to your relayer.
        </p>
      </section>
    );
  }
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
    } catch {
      /* clipboard unavailable — surface nothing; URL is already visible */
    }
  };
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold">Public endpoint</div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Published on-chain via{" "}
            <code className="font-mono">RelayerRegistry.operators().url</code>.
            Peers and Pro/Pay clients pick your relayer using this URL.
          </p>
          <div className="mt-2 truncate font-mono text-sm" title={trimmed}>
            {trimmed}
          </div>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="flex-shrink-0 rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg)]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
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
  const { bps: platformFeeBps } = usePlatformFeeBps();
  // On-chain-backed token resolver, published to the section so the
  // per-token cards and recent-settlement rows render real symbol +
  // decimals for tokens absent from NEXT_PUBLIC_TOKENS.
  const resolveToken = useTokenResolver();
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [recent, setRecent] = useState<SettlementRow[] | null>(null);
  const [feeTotals, setFeeTotals] = useState<FeeTotals | null>(null);
  const [volumeTotals, setVolumeTotals] = useState<VolumeTotals | null>(null);
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
      const [s, h, f, v, p] = await Promise.all([
        adminGet<StatusBody>(auth, "/api/admin/status"),
        adminGet<{ rows: SettlementRow[] }>(
          auth,
          `/api/admin/history?limit=200`,
        ),
        adminGet<FeeTotals>(auth, `/api/admin/history/fees?since=${since}`),
        // Volume endpoint shipped after fees — an older relayer the
        // dashboard is connected to would 404 here. Swallow into an
        // empty payload so the rest of the dashboard still renders,
        // and log so the operator can see why volume is blank.
        adminGet<VolumeTotals>(auth, `/api/admin/history/volume?since=${since}`).catch((err) => {
          console.warn("[dashboard] volume endpoint unavailable; rendering empty", err);
          return { totals: [] } as VolumeTotals;
        }),
        adminGet<BucketsBody>(
          auth,
          `/api/admin/history/buckets?since=${perfSince}&bucketMs=${60 * 60 * 1000}`,
        ),
      ]);
      setStatus(s);
      setRecent(h.rows);
      setFeeTotals(f);
      setVolumeTotals(v);
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
    <TokenResolverProvider value={resolveToken}>
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
        <SectionHeader
          title="Volume & fee (24h)"
          badge="live"
          hint="Two views of the same window. Fee answers 'what did I earn'; volume answers 'what did I route'."
        />
        <div className="grid gap-4 md:grid-cols-2">
          <VolumeCard volume={volumeTotals} />
          <RevenueCard fees={feeTotals} platformFeeBps={platformFeeBps} />
        </div>
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
              <RecentSettlementRow key={s.tx_hash} row={s} platformFeeBps={platformFeeBps} />
            ))}
          </div>
        )}
      </section>
    </TokenResolverProvider>
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


/** Single row in the Recent settlements list. Lays out three info
 *  blocks: type/status + tx, sell-leg volume + per-token fee revenue,
 *  and gas + timing. Volume falls back to "—" for pre-migration rows
 *  and shared-OB back-filled rows that have NULL amounts. */
function RecentSettlementRow({ row, platformFeeBps }: { row: SettlementRow; platformFeeBps: number | null }) {
  const resolveToken = useResolveToken();
  const sellInfo = row.sell_token ? resolveToken(row.sell_token) : null;
  return (
    <div className="grid grid-cols-12 items-center gap-3 border-b border-[var(--color-border)] px-5 py-4 last:border-b-0">
      <div className="col-span-5 min-w-0">
        <div className="font-medium">
          {row.type}{" "}
          <span
            className={`ml-2 inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
              row.status === "confirmed"
                ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
            }`}
          >
            {row.status}
          </span>
        </div>
        <div className="truncate font-mono text-xs text-[var(--color-text-muted)]" title={row.tx_hash}>
          {row.tx_hash}
        </div>
      </div>
      {/* Volume + fee block — the per-tx "what flowed, what we earned"
          summary. Volume is the sell leg only (= what this relayer's
          user brought in); fee can have multiple tokens for same-
          relayer matches that earned in both legs' buyTokens. */}
      <div className="col-span-4 text-right">
        <div className="font-mono text-xs">
          <span className="text-[var(--color-text-subtle)]">vol </span>
          {row.sell_amount && sellInfo
            ? `${formatAmount(row.sell_amount, sellInfo.decimals)} ${sellInfo.symbol}`
            : "—"}
        </div>
        <div className="mt-0.5 font-mono text-xs">
          <span className="text-[var(--color-text-subtle)]">fee </span>
          {(row.fees ?? []).length === 0
            ? "—"
            : (row.fees ?? [])
                .map((f) => {
                  const fi = resolveToken(f.token);
                  return `${formatAmount(f.amountWei, fi.decimals)} ${fi.symbol}`;
                })
                .join(" + ")}
        </div>
        {/* Net-after-platform-cut line — only when the bps is known
            AND at least one fee row exists. Skipped when bps=0 (no
            cut configured) to avoid duplicating the gross line. */}
        {platformFeeBps !== null && platformFeeBps > 0 && (row.fees ?? []).length > 0 && (
          <div className="font-mono text-[10px] text-[var(--color-text-subtle)]">
            net{" "}
            {(row.fees ?? [])
              .map((f) => {
                const fi = resolveToken(f.token);
                const netWei = netAfterPlatformFee(f.amountWei, platformFeeBps);
                return netWei !== null
                  ? `${formatAmount(netWei, fi.decimals)} ${fi.symbol}`
                  : `— ${fi.symbol}`;
              })
              .join(" + ")}
          </div>
        )}
      </div>
      <div className="col-span-3 text-right">
        <div className="font-mono text-sm">
          {row.gas_cost_eth ? `${row.gas_cost_eth} ETH` : "—"}
        </div>
        <div className="text-xs text-[var(--color-text-subtle)]">
          {formatRelative(row.created_at)} · block {row.block_number ?? "?"}
        </div>
      </div>
    </div>
  );
}
