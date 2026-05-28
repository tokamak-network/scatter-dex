"use client";

/**
 *  `/relayer?address=<addr>` — public read-only profile for any
 *  registered relayer. Migrated from `/relayer/[address]` so the
 *  Operators bundle's `output: "export"` config can build without
 *  needing a `generateStaticParams()` over an unbounded address
 *  space — see the convention note in `next.config.ts`.
 *
 *  Reads the on-chain row via `loadOperatorRow` and probes the
 *  target's `/api/info` + `/api/relayer/stats` for live counters,
 *  so visitors can inspect a peer's fee, bond, success rate, and
 *  live endpoint without needing admin auth on that peer. Lives in
 *  the operators app (rather than a separate marketing site) so
 *  the leaderboard row's link target sits one click away.
 *
 *  Anonymous visitors work — no "you" highlight, no edit
 *  affordances; owners discover their own row from `/dashboard`
 *  instead.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadOperatorRow,
  RelayerClient,
  fetchRelayerStatsFromSharedOrderbook,
  unwrapEthersError,
  type OperatorRow,
  type RelayerApiInfo,
  type RelayerStatsResponse,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { SectionHeader } from "../components/SectionHeader";
import { DEMO_NETWORK } from "../lib/network";
import { formatIsoDate } from "../lib/format";
import { safeOperatorUrl } from "../lib/operatorDisplay";
import { formatAmount, tokenInfo } from "../lib/tokenRegistry";

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;
// Shared-OB indexer URL — when set, the detail page sources
// volume/revenue from the network indexer (matches leaderboard).
// Falls back to the peer's /api/relayer/stats when unset OR when
// the shared-OB query fails (older deployments without an indexer).
const SHARED_OB_URL = process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL;

interface PageState {
  loading: boolean;
  row: OperatorRow | null;
  /** Live `/api/info` payload from the target relayer, captured so
   *  the display name can fall back to `profile.name` / `api.name`
   *  (matching the leaderboard's preference order) when the on-chain
   *  row's `name` field is empty or stale. */
  api: RelayerApiInfo | null;
  stats: RelayerStatsResponse | null;
  online: boolean;
  error: string | null;
  notRegistered: boolean;
}

const INITIAL_STATE: PageState = {
  loading: false,
  row: null,
  api: null,
  stats: null,
  online: false,
  error: null,
  notRegistered: false,
};

/** `useSearchParams()` must live under a Suspense boundary for
 *  `output: "export"` to build / render — Next bails out otherwise
 *  with "useSearchParams() should be wrapped in a suspense
 *  boundary." Split the page into an outer Suspense host + inner
 *  body so the hook stays where the URL state actually needs to be
 *  read. */
export default function RelayerDetailPage() {
  return (
    <Suspense fallback={<Notice tone="info">Loading relayer detail…</Notice>}>
      <RelayerDetailBody />
    </Suspense>
  );
}

function RelayerDetailBody() {
  const search = useSearchParams();
  // Query-string addresses are forwarded as-is to `loadOperatorRow`
  // + the RelayerRegistry — Solidity address args are
  // case-insensitive, so no explicit normalization is needed. The
  // route may be visited with no `address` param (e.g. an internal
  // link without context), in which case we render the
  // "no relayer selected" notice instead of erroring.
  const targetAddress = (search?.get("address") ?? "").trim();
  const { readProvider } = useWallet();
  const registryDeployed = isConfiguredAddress(REGISTRY);
  const [state, setState] = useState<PageState>(INITIAL_STATE);

  useEffect(() => {
    if (!registryDeployed || !targetAddress) {
      setState(INITIAL_STATE);
      return;
    }
    let cancelled = false;
    // Reset to INITIAL_STATE on every target change so an in-flight
    // nav between ?address=A → ?address=B doesn't briefly render
    // A's row/stats under B's URL while the new fetch is in flight.
    setState({ ...INITIAL_STATE, loading: true });
    loadOperatorRow(REGISTRY, targetAddress, readProvider)
      .then(async (row) => {
        if (cancelled) return;
        if (row.registeredAt === 0) {
          setState({ ...INITIAL_STATE, notRegistered: true });
          return;
        }
        // Only probe the live endpoints when the on-chain row has a
        // URL — saves a guaranteed-to-fail network call when the
        // operator hasn't published one yet.
        let api: RelayerApiInfo | null = null;
        let stats: RelayerStatsResponse | null = null;
        let online = false;
        if (row.url) {
          const client = new RelayerClient(row.url, { timeoutMs: 4000 });
          // info from the peer (live /api/info probe — only the peer
          // itself can answer "am I up right now"), stats from the
          // shared-OB indexer when configured so the detail page
          // matches the leaderboard's totals. Falling back to the
          // peer's /api/relayer/stats keeps the page working in
          // environments without a shared OB (older deployments).
          const [infoR, sharedStats] = await Promise.allSettled([
            client.getInfo(),
            SHARED_OB_URL
              ? fetchRelayerStatsFromSharedOrderbook(SHARED_OB_URL, targetAddress, 4000)
              : Promise.resolve(null),
          ]);
          if (infoR.status === "fulfilled") {
            online = true;
            api = infoR.value;
          }
          const sharedOk = sharedStats.status === "fulfilled" ? sharedStats.value : null;
          if (sharedOk) {
            stats = sharedOk;
          } else {
            const peerStats = await client.getStats().catch(() => null);
            stats = peerStats;
          }
        }
        if (cancelled) return;
        setState({
          loading: false,
          row,
          api,
          stats,
          online,
          error: null,
          notRegistered: false,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load relayer detail", e);
        setState({
          ...INITIAL_STATE,
          error: unwrapEthersError(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [registryDeployed, readProvider, targetAddress]);

  const { row, api, stats, online, loading, error, notRegistered } = state;
  const safeUrl = safeOperatorUrl(row?.url);
  // Display-name preference mirrors the leaderboard's `relayerDisplayName`
  // helper: API profile > API top-level name > on-chain row name >
  // fallback. Keeps the detail page in sync with the leaderboard so
  // an operator who edits their off-chain profile sees that name on
  // both surfaces immediately.
  const displayName =
    api?.profile?.name?.trim() ||
    api?.name?.trim() ||
    row?.name?.trim() ||
    (row ? "Relayer" : "Relayer detail");

  return (
    <div className="space-y-10">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{displayName}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Public profile from{" "}
            <code className="font-mono">RelayerRegistry</code>. No admin auth
            required.
          </p>
        </div>
        <Link
          href="/leaderboard"
          className="text-sm text-[var(--color-primary)] hover:underline"
        >
          ← Leaderboard
        </Link>
      </header>

      {!registryDeployed && (
        <Notice tone="warn">
          RelayerRegistry isn&apos;t deployed on this network — there&apos;s no
          public profile data to show.
        </Notice>
      )}

      {registryDeployed && !targetAddress && (
        <Notice tone="info">
          No relayer selected. Pick one from{" "}
          <Link href="/leaderboard" className="text-[var(--color-primary)] underline">
            the leaderboard
          </Link>
          .
        </Notice>
      )}

      {registryDeployed && targetAddress && loading && (
        <Notice tone="info">Loading on-chain row + live stats…</Notice>
      )}

      {registryDeployed && !loading && error && (
        <Notice tone="warn">Failed to load: {error}</Notice>
      )}

      {registryDeployed && !loading && !error && notRegistered && (
        <Notice tone="warn">
          No relayer registered at this address. Check the leaderboard for the
          current set.
        </Notice>
      )}

      {row && (
        <>
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="flex flex-wrap items-center gap-3">
              <HealthDot online={online} />
              <span className="font-mono text-sm" title={targetAddress}>
                {targetAddress}
              </span>
              {row.exitRequestedAt > 0 && (
                <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
                  exiting
                </span>
              )}
              {!row.active && row.registeredAt > 0 && row.exitRequestedAt === 0 && (
                <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-subtle)]">
                  inactive
                </span>
              )}
            </div>
            <div className="mt-3 text-sm">
              <span className="text-[var(--color-text-muted)]">Endpoint: </span>
              {safeUrl ? (
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[var(--color-primary)] hover:underline"
                >
                  {safeUrl}
                </a>
              ) : row.url ? (
                <span
                  className="font-mono text-[var(--color-warning)]"
                  title="URL has an unsupported scheme; not rendered as a link."
                >
                  {row.url}
                </span>
              ) : (
                <span className="text-[var(--color-text-muted)]">
                  not published on-chain
                </span>
              )}
            </div>
            {safeUrl && (
              <HealthCheckRow url={safeUrl} initialOnline={online} initialStats={stats} />
            )}
          </section>

          <section>
            <SectionHeader title="On-chain" badge="live" />
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Fee"
                value={`${(row.feeBps / 100).toFixed(2)}%`}
                sub={`${row.feeBps} bps per fill`}
              />
              <Stat
                label="Bond posted"
                value={`${row.bondEth} ETH`}
                sub={row.active ? "Active" : "Not active"}
              />
              <Stat
                label="Registered"
                value={formatIsoDate(row.registeredAt)}
                sub={<DaysAgo unixSec={row.registeredAt} />}
              />
            </div>
          </section>

          <section>
            <SectionHeader title="Performance" badge="live" />
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Settled orders"
                value={
                  stats?.settledOrders !== undefined
                    ? String(stats.settledOrders)
                    : "—"
                }
                sub={
                  stats?.totalOrders !== undefined
                    ? `of ${stats.totalOrders} routed`
                    : "stats unavailable"
                }
              />
              <Stat
                label="Success rate"
                value={
                  stats?.successRate !== undefined
                    ? `${stats.successRate}%`
                    : "—"
                }
                sub={
                  stats?.pendingOrders !== undefined
                    ? `${stats.pendingOrders} pending`
                    : undefined
                }
              />
              <Stat
                label="Avg settle time"
                value={
                  stats?.avgSettleTimeMs != null
                    ? `${Math.round(stats.avgSettleTimeMs)} ms`
                    : "—"
                }
                sub={
                  stats?.uptimeSince
                    ? `up since ${formatIsoDate(Math.floor(stats.uptimeSince / 1000))}`
                    : undefined
                }
              />
            </div>
          </section>

          {/* Per-token throughput (each row contributes the sell leg
              for scatterDirectAuth and BOTH legs for settleAuth — see
              `getSettledVolume` in zk-relayer/src/core/db.ts) + revenue
              (fee accruals). Cross-token totals can't be summed without
              a price oracle, so we render top-3 rows of each — the
              leaderboard's Volume / Revenue columns do the same. */}
          <section>
            <SectionHeader
              title="Routed volume & revenue"
              badge="live"
              hint="Per-token sums sourced from this relayer's /api/relayer/stats."
            />
            <div className="grid grid-cols-2 gap-4">
              <TokenTotalsCard
                title="Volume routed"
                empty="No settlements recorded yet."
                countLabel="fill"
                entries={(stats?.settledVolume ?? []).map((v) => ({
                  token: v.sellToken,
                  amount: v.totalVolume,
                  count: v.count,
                }))}
              />
              <TokenTotalsCard
                title="Fee revenue"
                empty="No fee accruals recorded yet."
                countLabel="accrual"
                entries={(stats?.feeTotals ?? []).map((f) => ({
                  token: f.token,
                  amount: f.totalWei,
                  count: f.count,
                }))}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Status dot + label. Lifted out of the header so the on-mount
 *  probe and the manual re-ping (`HealthCheckRow` below) can share
 *  the same visual. */
function HealthDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex h-2.5 w-2.5 rounded-full ${
        online ? "bg-[var(--color-success)]" : "bg-[var(--color-text-subtle)]"
      }`}
      title={
        online
          ? "Relayer responded to /api/info"
          : "Relayer didn't respond — offline or unreachable"
      }
    />
  );
}

/** Inline health-check affordance. The initial probe at mount tells
 *  us whether the endpoint was up at page-load; this row exposes a
 *  manual re-ping so the operator can verify it's still live now
 *  (and capture a round-trip latency reading). Independent of the
 *  parent `state.online` flag — clicking re-ping doesn't mutate the
 *  rest of the page, just this strip's badge + latency. */
function HealthCheckRow({
  url,
  initialOnline,
  initialStats,
}: {
  url: string;
  initialOnline: boolean;
  initialStats: RelayerStatsResponse | null;
}) {
  const [online, setOnline] = useState(initialOnline);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  // Unmount-safety: abort an in-flight ping and gate all setStates
  // behind a mounted flag. Without this, navigating away mid-ping
  // logs a React warning and (on dev mode strict-effects) double-
  // fires; in production it's a slow drip of resources held by the
  // resolved fetch.
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);
  const ping = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const client = new RelayerClient(url, { timeoutMs: 4000 });
      await client.getInfo(ctrl.signal);
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setOnline(true);
      setPingMs(Math.round(performance.now() - t0));
    } catch (e) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setOnline(false);
      setPingMs(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current && !ctrl.signal.aborted) {
        setLastChecked(Date.now());
        setBusy(false);
      }
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        Health
      </span>
      <HealthDot online={online} />
      <span>{online ? "online" : "offline"}</span>
      {pingMs !== null && (
        <span className="text-[var(--color-text-subtle)]">· {pingMs} ms /api/info</span>
      )}
      {initialStats?.uptimeSince && (
        <span className="text-[var(--color-text-subtle)]">
          · up since {formatIsoDate(Math.floor(initialStats.uptimeSince / 1000))}
        </span>
      )}
      {lastChecked && (
        <span className="text-[var(--color-text-subtle)]">
          · checked {new Date(lastChecked).toLocaleTimeString()}
        </span>
      )}
      <button
        type="button"
        onClick={ping}
        disabled={busy}
        className="ml-auto rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-bg)] disabled:opacity-50"
      >
        {busy ? "Pinging…" : "Ping now"}
      </button>
      {error && (
        <span className="basis-full text-[10px] text-[var(--color-warning)]">
          {error}
        </span>
      )}
    </div>
  );
}

/** Top-3 per-token totals card. Drives both the Volume routed and
 *  Fee revenue columns — they share the shape (token + wei amount +
 *  fill count) so a single component keeps them visually paired.
 *  Cross-token aggregation would need a price oracle; until then
 *  the operator scans top-3 by raw wei (sorted desc as bigint to
 *  beat Number precision loss). */
function TokenTotalsCard({
  title,
  empty,
  entries,
  countLabel,
}: {
  title: string;
  empty: string;
  entries: ReadonlyArray<{ token: string; amount: string; count: number }>;
  /** Singular noun for the per-row "<n> <label>(s)" tally. The Volume
   *  card uses "fill"; the Fee revenue card uses "accrual" because a
   *  single settlement records both maker- and taker-side fees, so
   *  fee_history row count is not 1:1 with fills. */
  countLabel: string;
}) {
  // Pre-parse amounts to BigInt once so the comparator below is a
  // consistent preorder. Wrapping `BigInt()` inside `.sort` and
  // returning `0` on throw breaks transitivity: an entry that
  // failed to parse compares equal to every other entry, including
  // entries that are not equal to each other — V8's sort can then
  // produce an unstable order or hit a comparator-violation in
  // strict mode. Unparseable amounts sink to the bottom.
  const parsed = entries.map((e) => {
    let value: bigint;
    let valid = true;
    try {
      value = BigInt(e.amount);
    } catch {
      value = 0n;
      valid = false;
    }
    return { entry: e, value, valid };
  });
  parsed.sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    if (a.value === b.value) return 0;
    return a.value > b.value ? -1 : 1;
  });
  const sorted = parsed.map((p) => p.entry);
  const top = sorted.slice(0, 3);
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
        {title}
      </div>
      {top.length === 0 ? (
        <div className="mt-2 text-sm text-[var(--color-text-muted)]">{empty}</div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {top.map((e) => {
            const info = tokenInfo(e.token);
            return (
              <li
                key={e.token}
                className="flex items-baseline justify-between gap-2 text-sm"
              >
                <span className="font-medium">{info.symbol}</span>
                <span className="font-mono">
                  {formatAmount(e.amount, info.decimals)}
                  <span className="ml-1 text-[10px] text-[var(--color-text-subtle)]">
                    {e.count} {countLabel}{e.count === 1 ? "" : "s"}
                  </span>
                </span>
              </li>
            );
          })}
          {sorted.length > top.length && (
            <li className="text-[10px] text-[var(--color-text-subtle)]">
              +{sorted.length - top.length} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warn";
  children: React.ReactNode;
}) {
  const cls =
    tone === "warn"
      ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]";
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}

/** Relative-time sub-label for the "Registered" stat. Computing it
 *  during render against `Date.now()` causes a hydration mismatch
 *  because SSR's clock differs from the client's; we initialise to
 *  `null` (suppressed on first paint) and fill in on mount. */
function DaysAgo({ unixSec }: { unixSec: number }) {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    if (!unixSec) return;
    const ms = Date.now() - unixSec * 1000;
    setDays(Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000))));
  }, [unixSec]);
  if (days === null) return null;
  return <>{days} days ago</>;
}
