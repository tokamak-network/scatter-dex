"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { SectionHeader } from "../components/SectionHeader";
import { AdminConnectBar } from "../components/AdminConnectBar";
import { Stat } from "../components/Stat";
import { adminDownload, adminGet, readAdminAuth, type AdminAuth } from "../lib/adminApi";
import { RevenueCard, VolumeCard } from "../components/PerTokenCards";
import { usePlatformFeeBps } from "../lib/usePlatformFeeBps";

type Auth = AdminAuth | null;

interface FeeTotal {
  token: string;
  count: number;
  totalWei: string;
}
interface VolumeTotal {
  token: string;
  sellFills: number;
  buyFills: number;
  totalSellWei: string;
  totalBuyWei: string;
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

// Period toggle. `bucketMs` chosen so the chart never lands on the
// 1024-bucket DB cap (~42d at 1h, ~341d at 8h) and the eye still gets
// a useful granularity — hourly within a week, daily beyond. The
// admin endpoint also clamps upward, so any oversight here degrades
// instead of erroring.
const PERIODS = [
  { id: "1d", label: "24h", ms: 24 * 3600_000, bucketMs: 3600_000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 3600_000, bucketMs: 3600_000 },
  { id: "30d", label: "30 days", ms: 30 * 24 * 3600_000, bucketMs: 24 * 3600_000 },
  { id: "90d", label: "90 days", ms: 90 * 24 * 3600_000, bucketMs: 24 * 3600_000 },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

export default function AnalyticsPage() {
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
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Per-period throughput and fee revenue for your relayer.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="text-sm text-[var(--color-primary)] hover:underline"
        >
          ← Dashboard
        </Link>
      </section>

      {hydrated && (
        <AdminConnectBar
          auth={auth}
          onAuth={setAuth}
          title="Relayer admin"
          subtitle="Connect to load fee + volume aggregates from settlement_history."
        />
      )}

      {hydrated && auth ? <AnalyticsBody auth={auth} /> : null}
    </div>
  );
}

function AnalyticsBody({ auth }: { auth: NonNullable<Auth> }) {
  const { bps: platformFeeBps } = usePlatformFeeBps();
  const [period, setPeriod] = useState<PeriodId>("7d");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [fees, setFees] = useState<FeeTotal[] | null>(null);
  const [volume, setVolume] = useState<VolumeTotal[] | null>(null);
  const [buckets, setBuckets] = useState<BucketsBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [window, setWindow] = useState<{ since: number; until: number }>(() => {
    const until = Date.now();
    return { since: until - PERIODS[1].ms, until };
  });

  const periodCfg = PERIODS.find((p) => p.id === period) ?? PERIODS[1];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Snapshot the window once per fetch so all three responses share
    // a consistent [since, until). Without this, network jitter could
    // land fees, volume, and buckets in three different windows and
    // the per-token table would silently disagree with the chart.
    const until = Date.now();
    const since = until - periodCfg.ms;
    setWindow({ since, until });
    Promise.all([
      adminGet<{ totals: FeeTotal[] }>(
        auth,
        `/api/admin/history/fees?since=${since}&until=${until}`,
      ),
      adminGet<{ totals: VolumeTotal[] }>(
        auth,
        `/api/admin/history/volume?since=${since}&until=${until}`,
      ),
      adminGet<BucketsBody>(
        auth,
        `/api/admin/history/buckets?since=${since}&until=${until}&bucketMs=${periodCfg.bucketMs}`,
      ),
    ])
      .then(([f, v, b]) => {
        if (cancelled) return;
        setFees(f.totals);
        setVolume(v.totals);
        setBuckets(b);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, periodCfg.ms, periodCfg.bucketMs, refreshNonce]);

  // Tokens routed = distinct tokens that appear in either fees OR
  // volume. Falling back to `volume?.length` alone hides fee-earning
  // tokens whose settlements predate the sell_amount/buy_amount
  // columns and therefore don't show up in the volume aggregate.
  const tokensRoutedCount = useMemo(() => {
    const set = new Set<string>();
    for (const f of fees ?? []) set.add(f.token);
    for (const v of volume ?? []) set.add(v.token);
    return set.size;
  }, [fees, volume]);

  const totals = useMemo(() => {
    // Single pass — three .reduce()s over the same array walked the
    // bucket list three times for the same result. Each step adds an
    // O(N) iteration that doesn't pay for itself.
    const { totalSettled, totalFailed, totalGas } = buckets?.buckets.reduce(
      (acc, b) => {
        acc.totalSettled += b.settled;
        acc.totalFailed += b.failed;
        acc.totalGas += (b.avgGasEth ?? 0) * b.settled;
        return acc;
      },
      { totalSettled: 0, totalFailed: 0, totalGas: 0 },
    ) ?? { totalSettled: 0, totalFailed: 0, totalGas: 0 };
    const avgGas = totalSettled > 0 ? totalGas / totalSettled : 0;
    const totalAttempts = totalSettled + totalFailed;
    const successRate = totalAttempts > 0 ? totalSettled / totalAttempts : null;
    return { totalSettled, totalFailed, avgGas, successRate };
  }, [buckets]);

  const downloadCsv = useCallback(async () => {
    // The CSV endpoint sits behind admin auth, so a plain anchor would
    // download an HTML 401 instead of the sheet. `adminDownload` owns
    // the auth header + URL constructor + Content-Disposition filename
    // + deferred revokeObjectURL (Safari race) — reuse it instead of
    // re-implementing those edge cases inline.
    try {
      setError(null);
      const params = new URLSearchParams({
        since: String(window.since),
        until: String(window.until),
      });
      const fallback = `settlements-${new Date(window.since).toISOString().slice(0, 10)}-to-${new Date(window.until).toISOString().slice(0, 10)}.csv`;
      await adminDownload(auth, `/api/admin/history.csv?${params.toString()}`, fallback);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [auth, window.since, window.until]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
          {PERIODS.map((p) => {
            const active = p.id === period;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod(p.id)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  active
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-[var(--color-text-muted)]">
            {new Date(window.since).toLocaleString()} → {new Date(window.until).toLocaleString()}
          </span>
          <button
            type="button"
            onClick={() => setRefreshNonce((n) => n + 1)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-bg)]"
            disabled={loading}
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <section>
        <SectionHeader title="Overview" badge="live" />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat
            label="Total settled"
            value={totals.totalSettled.toLocaleString()}
            sub={`${totals.totalFailed} failed`}
          />
          <Stat
            label="Success rate"
            value={
              totals.successRate === null
                ? "—"
                : `${(totals.successRate * 100).toFixed(1)}%`
            }
            sub="confirmed / attempts"
          />
          <Stat
            label="Avg gas / settle"
            value={totals.avgGas > 0 ? `${totals.avgGas.toFixed(6)} ETH` : "—"}
            sub="weighted by settled count"
          />
          <Stat
            label="Tokens routed"
            value={tokensRoutedCount.toLocaleString()}
            sub={fees ? `${fees.length} earning fees` : "—"}
          />
        </div>
      </section>

      <section>
        <SectionHeader
          title="Per-token volume & fee"
          badge="live"
          hint="Volume is the sell-leg notional this relayer routed (the counterparty's buy leg is the mirror). Fee sums accruals across all sides (maker + taker + scatterDirect)."
        />
        <div className="grid gap-4 md:grid-cols-2">
          <VolumeCard volume={volume ? { totals: volume } : null} />
          <RevenueCard fees={fees ? { totals: fees } : null} platformFeeBps={platformFeeBps} />
        </div>
      </section>

      <section>
        <SectionHeader title="Throughput over time" badge="live" />
        <ThroughputChart buckets={buckets} />
      </section>

      <section className="flex justify-end">
        <button
          type="button"
          onClick={downloadCsv}
          className="text-sm text-[var(--color-primary)] hover:underline"
        >
          Export settlements CSV →
        </button>
      </section>
    </>
  );
}

function ThroughputChart({ buckets }: { buckets: BucketsBody | null }) {
  if (!buckets) {
    return <div className="text-sm text-[var(--color-text-muted)]">Loading…</div>;
  }
  if (buckets.buckets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-text-muted)]">
        No buckets in this window.
      </div>
    );
  }
  const max = Math.max(1, ...buckets.buckets.map((b) => b.settled + b.failed));
  const isDaily = buckets.bucketMs >= 24 * 3600_000;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {/* `items-stretch` lets each bucket wrapper inherit the full
          h-40 height so percentage-height inner bars resolve. Stacking
          the bars with `flex flex-col justify-end` grows them from the
          bottom (matching how a column chart reads). */}
      <div className="flex h-40 items-stretch gap-px">
        {buckets.buckets.map((b) => {
          const total = b.settled + b.failed;
          const heightPct = (total / max) * 100;
          const failedPct = total > 0 ? (b.failed / total) * heightPct : 0;
          const settledPct = heightPct - failedPct;
          return (
            <div
              key={b.bucketStart}
              className="group relative flex flex-1 flex-col justify-end"
              title={`${new Date(b.bucketStart).toLocaleString()} · settled ${b.settled} · failed ${b.failed} · p95 ${b.p95Ms ?? "—"}ms`}
            >
              <div
                className="bg-[var(--color-danger)]"
                style={{ height: `${failedPct}%` }}
              />
              <div
                className="bg-[var(--color-primary)]"
                style={{ height: `${settledPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-[var(--color-text-subtle)]">
        <span>
          {isDaily ? "daily" : "hourly"} · settled (green) + failed (red), max {max}
        </span>
        <span>
          {new Date(buckets.since).toLocaleDateString()} → {new Date(buckets.until).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
}
