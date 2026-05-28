"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type KeyboardEvent } from "react";
import { ethers } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { LiveFreshness, shortAddr, useTimedRefresh, useWallet } from "@zkscatter/sdk/react";
import {
  loadRelayersWithApiInfo,
  loadRelayersWithSharedOrderbookStats,
  unwrapEthersError,
  type RelayerInfo,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { SectionHeader } from "../components/SectionHeader";
import { DEMO_NETWORK } from "../lib/network";
import { formatEther } from "../lib/format";
import { relayerStatsCellStatus, type StatsCellStatus } from "../lib/relayerStatus";
import { formatAmount, tokenInfo } from "../lib/tokenRegistry";

/** Local USD price oracle — hardcoded for the dev environment so
 *  cross-token Volume/Revenue can collapse to a single comparable
 *  number. Replace with a Chainlink / CoinGecko fetch when wiring
 *  testnet/mainnet. Symbols are case-insensitive; tokens not in this
 *  table contribute $0 (and the cell shows a "?" tooltip). */
const USD_PRICES: Record<string, number> = {
  ETH: 3000,
  WETH: 3000,
  USDC: 1,
  USDT: 1,
  TON: 1.5,
};
function tokenUsd(wei: string, decimals: number, symbol: string): number | null {
  const px = USD_PRICES[symbol.toUpperCase()];
  if (px === undefined) return null;
  try {
    const denom = 10n ** BigInt(decimals);
    const v = BigInt(wei);
    const whole = Number(v / denom);
    const frac = Number(v % denom) / Number(denom);
    return (whole + frac) * px;
  } catch {
    return null;
  }
}
function sumUsd(
  rows: Array<{ token?: string; sellToken?: string; totalWei?: string; totalVolume?: string }>,
): { total: number; missing: number } {
  let total = 0;
  let missing = 0;
  for (const r of rows) {
    const tokAddr = r.token ?? r.sellToken;
    const wei = r.totalWei ?? r.totalVolume;
    if (!tokAddr || !wei) continue;
    const info = tokenInfo(tokAddr);
    const usd = tokenUsd(wei, info.decimals, info.symbol);
    if (usd === null) {
      missing += 1;
    } else {
      total += usd;
    }
  }
  return { total, missing };
}
function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;
// Shared-OB indexer URL — when set, leaderboard stats come from the
// network-wide settlements indexer (durable across relayer DB
// resets, sell-only attribution, fees split per maker/taker leg).
// Falls back to per-peer `/api/relayer/stats` when unset.
const SHARED_OB_URL = process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL;

interface LeaderboardState {
  loading: boolean;
  rows: RelayerInfo[];
  error: string | null;
}

/** Ranking criteria the leaderboard lets the visitor pick from.
 *  Each entry knows its display label, its sort direction's "better"
 *  side, and a comparator that pulls the metric off a RankedRelayer.
 *  Centralising the choices here (instead of one switch per use site)
 *  keeps the table header arrow, the segmented control, and the
 *  caption copy from drifting apart. */
type RankCriterionId = "volume" | "revenue" | "activity" | "bond" | "fee" | "success" | "speed";
interface RankCriterion {
  id: RankCriterionId;
  label: string;
  description: string;
  /** Returns +1 / -1 / 0 to feed into Array.sort. Implementations
   *  treat undefined metrics as worse than any defined value so an
   *  offline relayer doesn't accidentally rank above a peer just
   *  because its missing field reads as Infinity. */
  compare: (a: RankedRelayer, b: RankedRelayer) => number;
}

// Treat undefined as worse than any defined number — peers without a
// stats probe fall to the bottom in any "more is better" ranking
// instead of getting a free pass to the top.
function compareNullable(
  a: number | null | undefined,
  b: number | null | undefined,
  desc: boolean,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return desc ? b - a : a - b;
}

const RANK_CRITERIA: RankCriterion[] = [
  {
    id: "volume",
    label: "Volume",
    description: "Highest USD-equivalent throughput first",
    // Reads the Schwartzian-decorated sort key off RankedRelayer
    // instead of recomputing per comparison — see rankRelayers.
    compare: (a, b) => compareNullable(a.volumeUsd, b.volumeUsd, true),
  },
  {
    id: "revenue",
    label: "Fee",
    description: "Highest USD-equivalent fee earned first",
    compare: (a, b) => compareNullable(a.revenueUsd, b.revenueUsd, true),
  },
  {
    id: "activity",
    label: "Settled",
    description: "Most settled orders first",
    compare: (a, b) =>
      compareNullable(a.stats?.settledOrders, b.stats?.settledOrders, true),
  },
  {
    id: "bond",
    label: "Bond",
    description: "Most skin-in-the-game first",
    compare: (a, b) => {
      if (a.bond !== b.bond) return b.bond > a.bond ? 1 : -1;
      return a.fee - b.fee;
    },
  },
  {
    id: "fee",
    label: "Fee",
    description: "Cheapest per-trade fee first",
    compare: (a, b) => {
      if (a.fee !== b.fee) return a.fee - b.fee;
      return b.bond > a.bond ? 1 : -1;
    },
  },
  {
    id: "success",
    label: "Success",
    description: "Highest success rate first",
    compare: (a, b) =>
      compareNullable(a.stats?.successRate, b.stats?.successRate, true),
  },
  {
    id: "speed",
    label: "Speed",
    description: "Lowest avg settle latency first",
    compare: (a, b) =>
      compareNullable(a.stats?.avgSettleTimeMs, b.stats?.avgSettleTimeMs, false),
  },
];

// Sort-comparator helper: collapse a relayer's per-token stats into
// a single USD-equivalent total via the local price oracle. Returns
// undefined when the relayer has no stats at all (caller treats
// undefined as worse than any defined value via compareNullable).
function usdTotal(
  rows: Array<{ token?: string; sellToken?: string; totalWei?: string; totalVolume?: string }> | undefined,
): number | undefined {
  if (!rows || rows.length === 0) return undefined;
  return sumUsd(rows).total;
}

function criterionById(id: RankCriterionId): RankCriterion {
  return RANK_CRITERIA.find((c) => c.id === id) ?? RANK_CRITERIA[0];
}

export default function LeaderboardPage() {
  const { account, readProvider } = useWallet();
  const registryDeployed = isConfiguredAddress(REGISTRY);
  const [state, setState] = useState<LeaderboardState>({ loading: false, rows: [], error: null });
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  // Bump this to force an out-of-cadence refresh from the user
  // pressing the "refresh" link on the LiveFreshness pill.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!registryDeployed) {
      setState({ loading: false, rows: [], error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const loader = SHARED_OB_URL
      ? loadRelayersWithSharedOrderbookStats(REGISTRY, readProvider, SHARED_OB_URL)
      : loadRelayersWithApiInfo(REGISTRY, readProvider, { withStats: true });
    loader
      .then((rows) => {
        if (cancelled) return;
        setState({ loading: false, rows, error: null });
        // Only stamp on success; a failed fetch leaves the prior
        // freshness so the user can see "live · 2m ago" stop ticking
        // and reason about staleness.
        setLastRefreshedAt(Date.now());
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load leaderboard", e);
        setState({ loading: false, rows: [], error: unwrapEthersError(e) });
      });
    return () => { cancelled = true; };
  }, [registryDeployed, readProvider, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);
  // Same polling cadence as the SDK's RelayersProvider so the
  // leaderboard catches new registrations within ~30s, with a tab-
  // focus immediate refresh on top.
  useTimedRefresh({ refresh, intervalMs: 30_000, enabled: registryDeployed });

  const [criterionId, setCriterionId] = useState<RankCriterionId>("volume");
  const criterion = criterionById(criterionId);
  const accountLc = account?.toLowerCase() ?? null;
  const ranked = useMemo(
    () => rankRelayers(state.rows, criterion),
    [state.rows, criterion],
  );
  const placeholder = leaderboardPlaceholder(state, registryDeployed);
  const me = accountLc ? ranked.find((r) => r.address.toLowerCase() === accountLc) : undefined;
  const medianFeeBps = ranked.length > 0 ? medianBps(ranked.map((r) => r.fee)) : null;

  return (
    <div className="space-y-10">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leaderboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Network-wide relayer ranking from the on-chain registry. Pick a
            criterion below to re-sort — defaults to bond posted. Your relayer
            is highlighted.
          </p>
          {registryDeployed ? (
            <div className="mt-2">
              <LiveFreshness
                lastRefreshedAt={lastRefreshedAt}
                loading={state.loading}
                onRefresh={refresh}
              />
            </div>
          ) : null}
        </div>
        <Link href="/dashboard" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Dashboard
        </Link>
      </header>

      <section>
        <SectionHeader title="On-chain" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Your rank"
            value={placeholder ? placeholder.value : me ? `#${me.rank}` : "—"}
            sub={placeholder ? placeholder.sub : rankSub(me, account)}
          />
          <Stat
            label="Active relayers"
            value={placeholder ? placeholder.value : String(ranked.length)}
            sub={placeholder ? placeholder.sub : "RelayerRegistry.getActiveRelayers"}
          />
          <Stat
            label="Median fee"
            value={placeholder ? placeholder.value : medianFeeBps != null ? `${medianFeeBps} bps` : "—"}
            sub={placeholder ? placeholder.sub : medianFeeBps != null ? `${(medianFeeBps / 100).toFixed(2)}%` : "No relayers"}
          />
        </div>
      </section>

      {me && (
        <SelfComparison me={me} ranked={ranked} />
      )}

      <section>
        <SectionHeader
          title="Ranking"
          badge="live"
          hint={`Click a column header to sort · ${criterion.description}`}
        />
        <RelayerTable
          ranked={ranked}
          placeholder={placeholder}
          accountLc={accountLc}
          activeCriterion={criterionId}
          onSortChange={setCriterionId}
        />
        <NetworkTotalsStrip ranked={ranked} />
        <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
          Status dot reflects a live <code className="font-mono">/api/info</code> probe.
          Settlement counters, volume, and avg-settle latency come from the shared
          orderbook indexer (durable across relayer DB resets); per-leg fee splits
          credit the relayer that brought each order, not just the on-chain submitter.
          Volume / Fee collapse to a single USD-equivalent total via a local
          price oracle (<code className="font-mono">USD_PRICES</code>; replace with
          Chainlink/CoinGecko before mainnet), and the Volume / Fee columns rank
          by that USD sum across all priced tokens. Per-token amounts are visible in
          each row&apos;s expand drawer.{" "}
          <strong>Fee figures are gross</strong> — each relayer&apos;s net is the
          fee minus the platform cut (
          <code className="font-mono">FeeVault.platformFeeBps</code>) at{" "}
          <code className="font-mono">claim()</code> time. See your own dashboard for
          the post-cut figure.
        </p>
      </section>
    </div>
  );
}

function SelfComparison({ me, ranked }: { me: RankedRelayer; ranked: RankedRelayer[] }) {
  // Network medians exclude the operator's own row so the comparison
  // is "me vs everyone else", not "me vs myself+everyone". Only peers
  // with a stats probe contribute to the latency/success medians.
  const peers = ranked.filter((r) => r.address !== me.address);
  const { peerSettled, peerSuccess, peerAvg } = peers.reduce(
    (acc, r) => {
      const s = r.stats;
      if (typeof s?.settledOrders === "number") acc.peerSettled.push(s.settledOrders);
      if (typeof s?.successRate === "number") acc.peerSuccess.push(s.successRate);
      if (typeof s?.avgSettleTimeMs === "number") acc.peerAvg.push(s.avgSettleTimeMs);
      return acc;
    },
    { peerSettled: [] as number[], peerSuccess: [] as number[], peerAvg: [] as number[] },
  );

  const myStats = me.stats;
  return (
    <section>
      <SectionHeader title="You vs network median" badge="live" />
      <div className="grid grid-cols-3 gap-4">
        <ComparisonStat
          label="Settled orders"
          mine={myStats?.settledOrders}
          peerMedian={median(peerSettled)}
          format={(n) => n.toString()}
          higherIsBetter
        />
        <ComparisonStat
          label="Success rate"
          mine={myStats?.successRate}
          peerMedian={median(peerSuccess)}
          format={(n) => `${n}%`}
          higherIsBetter
        />
        <ComparisonStat
          label="Avg settle time"
          mine={myStats?.avgSettleTimeMs ?? undefined}
          peerMedian={median(peerAvg)}
          format={(n) => `${Math.round(n)} ms`}
          higherIsBetter={false}
        />
      </div>
      {!myStats && (
        <p className="mt-2 text-xs text-[var(--color-warning)]">
          Your relayer didn&apos;t respond to the <code className="font-mono">/api/relayer/stats</code>{" "}
          probe. Check that it&apos;s reachable from this browser at{" "}
          <code className="font-mono">{me.url}</code>.
        </p>
      )}
    </section>
  );
}

type ComparisonTone = "good" | "bad" | "neutral";

function ComparisonStat({
  label,
  mine,
  peerMedian,
  format,
  higherIsBetter,
}: {
  label: string;
  mine: number | undefined;
  peerMedian: number | null;
  format: (n: number) => string;
  higherIsBetter: boolean;
}) {
  let tone: ComparisonTone = "neutral";
  if (mine !== undefined && peerMedian !== null) {
    const meetsBar = higherIsBetter ? mine >= peerMedian : mine <= peerMedian;
    tone = meetsBar ? "good" : "bad";
  }
  const toneClass =
    tone === "good"
      ? "text-[var(--color-success)]"
      : tone === "bad"
      ? "text-[var(--color-warning)]"
      : "text-[var(--color-text)]";
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
        {label}
      </div>
      <div className={`mt-1 font-mono text-2xl font-semibold ${toneClass}`}>
        {mine === undefined ? "—" : format(mine)}
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        Peer median: {peerMedian === null ? "—" : format(peerMedian)}
      </div>
    </div>
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface RankedRelayer extends RelayerInfo {
  rank: number;
  displayName: string;
  /** Precomputed USD totals — derived once per render of the
   *  leaderboard so the volume/revenue comparator doesn't re-iterate
   *  the per-token list on every Array.sort comparison (O(n log n)
   *  comparisons × O(k) tokens = an avoidable O(n k log n) per sort,
   *  and Schwartzian-decorating beats memoising inside the
   *  comparator because the sort doesn't reuse the result between
   *  comparisons). Undefined when the relayer has no stats at all
   *  — the comparator treats undefined as worse than 0. */
  volumeUsd?: number;
  revenueUsd?: number;
}

function rankRelayers(
  rows: RelayerInfo[],
  criterion: RankCriterion,
): RankedRelayer[] {
  // Decorate-sort-undecorate: project the per-row metadata + the
  // USD sort keys ONCE before the sort, so the comparator never
  // re-walks the per-token settledVolume / feeTotals arrays.
  const projected: RankedRelayer[] = rows.map((r) => ({
    ...r,
    rank: 0,
    displayName: relayerDisplayName(r),
    volumeUsd: usdTotal(r.stats?.settledVolume),
    revenueUsd: usdTotal(r.stats?.feeTotals),
  }));
  projected.sort(criterion.compare);
  return projected.map((r, i) => ({ ...r, rank: i + 1 }));
}

function relayerDisplayName(r: RelayerInfo): string {
  return r.api?.profile?.name?.trim() || r.api?.name?.trim() || shortAddr(r.address);
}

function rankSub(me: RankedRelayer | undefined, account: string | null): string {
  if (me) return "Among active relayers";
  if (account) return "Not registered";
  return "Connect wallet to see rank";
}

function medianBps(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

interface Placeholder { value: string; sub: string }

function leaderboardPlaceholder(state: LeaderboardState, registryDeployed: boolean): Placeholder | null {
  if (!registryDeployed) return { value: "—", sub: "Registry not deployed" };
  if (state.loading) return { value: "…", sub: "Reading registry" };
  if (state.error) return { value: "—", sub: `Read error: ${state.error}` };
  return null;
}

const TABLE_COLUMNS = 10;

// Map each sort criterion onto the column header it should highlight.
// Centralised so the arrow indicator + the sort selector can't drift.
const CRITERION_TO_COLUMN: Record<RankCriterionId, string> = {
  volume: "volume",
  revenue: "revenue",
  activity: "settled",
  bond: "bond",
  fee: "fee",
  success: "success",
  speed: "speed",
};

function RelayerTable({
  ranked,
  placeholder,
  accountLc,
  activeCriterion,
  onSortChange,
}: {
  ranked: RankedRelayer[];
  placeholder: Placeholder | null;
  accountLc: string | null;
  activeCriterion: RankCriterionId;
  onSortChange: (id: RankCriterionId) => void;
}) {
  const activeColumn = CRITERION_TO_COLUMN[activeCriterion];
  // Header for a sortable column — clicking sets the sort criterion,
  // and the active column gets a down arrow + bolded label so the
  // active sort is visible without a separate pill bar above the
  // table. Non-sortable columns (#, Relayer, Address, Registered)
  // render as plain <th> via SortableTh's `criterion={null}` branch.
  const SortableTh = ({
    label,
    column,
    criterion,
    align = "right",
  }: {
    label: string;
    column: string;
    criterion: RankCriterionId | null;
    align?: "left" | "right";
  }) => {
    const isActive = column === activeColumn;
    const justify = align === "right" ? "justify-end" : "justify-start";
    const text = align === "right" ? "text-right" : "text-left";
    if (!criterion) {
      return <th className={`px-5 py-3 ${text}`}>{label}</th>;
    }
    return (
      <th className={`px-5 py-3 ${text}`}>
        <button
          type="button"
          onClick={() => onSortChange(criterion)}
          aria-sort={isActive ? "descending" : "none"}
          className={`group inline-flex items-center gap-1 ${justify} w-full uppercase tracking-wide text-[var(--color-text-subtle)] hover:text-[var(--color-text)] focus:outline-none focus-visible:text-[var(--color-text)] ${
            isActive ? "font-semibold text-[var(--color-text)]" : ""
          }`}
        >
          {label}
          <span
            aria-hidden
            className={isActive ? "" : "opacity-30 group-hover:opacity-60"}
          >
            ↓
          </span>
        </button>
      </th>
    );
  };
  // Row-level expansion lives at the table so reordering or filtering
  // doesn't have to thread it through every row. Keyed by address —
  // the rank can shift between sorts and rank-based keys would close
  // the wrong drawer when the user re-sorts.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (addr: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const k = addr.toLowerCase();
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  return (
    // `overflow-x-auto` (not -hidden) so a too-wide table on a
    // narrow viewport falls back to a horizontal scroll instead of
    // silently chopping the last columns. With the Registered
    // column dropped (operators rarely sort by it; ops-team trust
    // signals live elsewhere), the table fits a standard desktop
    // viewport without scroll most of the time.
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        {/* Header had ~8 RGB units of contrast against the row bg
            (`--color-bg` #f7f8fb on `--color-surface` #ffffff) — the
            two melted into each other. Switch to slate-100 (an
            explicit darker neutral) + a thick bottom border so the
            thead clearly separates from the body. Can't reuse
            `--color-primary-soft` here: that's already taken by the
            "you" row highlight, and matching it would blur the
            "this is my row" cue. */}
        <thead className="border-b-2 border-[var(--color-border-strong)] bg-slate-100 text-xs">
          <tr>
            <SortableTh label="#" column="" criterion={null} align="left" />
            <SortableTh label="Relayer" column="" criterion={null} align="left" />
            <SortableTh label="Address" column="" criterion={null} align="left" />
            <SortableTh label="Fee rate" column="fee" criterion="fee" />
            <SortableTh label="Bond" column="bond" criterion="bond" />
            <SortableTh label="Settled" column="settled" criterion="activity" />
            <SortableTh label="Volume" column="volume" criterion="volume" />
            <SortableTh label="Fee" column="revenue" criterion="revenue" />
            <SortableTh label="Success" column="success" criterion="success" />
            <SortableTh label="Avg settle" column="speed" criterion="speed" />
          </tr>
        </thead>
        <tbody>
          {placeholder && <EmptyRow message={placeholder.sub} />}
          {!placeholder && ranked.length === 0 && <EmptyRow message="No active relayers yet." />}
          {!placeholder && ranked.map((r) => (
            <RelayerRow
              key={r.address}
              row={r}
              isMe={!!accountLc && r.address.toLowerCase() === accountLc}
              isExpanded={expanded.has(r.address.toLowerCase())}
              onToggle={() => toggle(r.address)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td colSpan={TABLE_COLUMNS} className="px-5 py-6 text-center text-sm text-[var(--color-text-muted)]">
        {message}
      </td>
    </tr>
  );
}

function RelayerRow({
  row,
  isMe,
  isExpanded,
  onToggle,
}: {
  row: RankedRelayer;
  isMe: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  // Only allow expansion when the per-token tables would actually
  // show something — a row whose peer's `/api/relayer/stats` returned
  // nothing has nothing to drill into.
  const canExpand =
    (row.stats?.settledVolume?.length ?? 0) > 0 ||
    (row.stats?.feeTotals?.length ?? 0) > 0;
  // Skip toggling when the click landed on a nested interactive
  // element (Next.js Link inside RelayerNameCell, future buttons).
  // Otherwise clicking the relayer name both navigates AND opens the
  // drawer, leaving the wrong row expanded on back-navigation.
  // `e.target` is typed `EventTarget` and (per React docs) may not
  // be an Element — e.g. a text-node target from contentEditable
  // children. Guard with `instanceof Element` so `.closest()` is
  // safe.
  const handleClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if (!canExpand) return;
    const t = e.target;
    if (t instanceof Element && t.closest("a,button,input,select,textarea")) return;
    onToggle();
  };
  // Keyboard parity: Enter / Space toggle when the row itself has
  // focus. We don't preventDefault on focus-target children — those
  // bubble through above and we'd block legitimate Link navigation.
  const handleKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (!canExpand) return;
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onToggle();
  };
  return (
    <>
      <tr
        className={`border-t border-[var(--color-border)] ${isMe ? "bg-[var(--color-primary-soft)]" : ""} ${canExpand ? "cursor-pointer hover:bg-[var(--color-bg)] focus:bg-[var(--color-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]" : ""}`}
        onClick={handleClick}
        onKeyDown={canExpand ? handleKeyDown : undefined}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? isExpanded : undefined}
      >
        <td className="px-5 py-3 font-semibold">
          {canExpand && (
            <span
              aria-hidden
              className="mr-1 inline-block text-[10px] text-[var(--color-text-subtle)]"
            >
              {isExpanded ? "▾" : "▸"}
            </span>
          )}
          <RankBadge rank={row.rank} />
        </td>
        <td className="px-5 py-3">
          <RelayerNameCell row={row} isMe={isMe} />
        </td>
        <td className="px-5 py-3 font-mono text-xs text-[var(--color-text-muted)]">{shortAddr(row.address)}</td>
        <td className="px-5 py-3 text-right">{(row.fee / 100).toFixed(2)}%</td>
        <td className="px-5 py-3 text-right font-mono">{formatEther(row.bond)} ETH</td>
        <StatCell row={row} value={row.stats?.settledOrders} render={(n) => String(n)} />
        <VolumeCell row={row} />
        <RevenueCell row={row} />
        <StatCell row={row} value={row.stats?.successRate} render={(n) => `${n}%`} />
        <StatCell
          row={row}
          value={row.stats?.avgSettleTimeMs}
          render={(n) => `${Math.round(n)} ms`}
        />
      </tr>
      {isExpanded && canExpand && <RelayerDetailRow row={row} />}
    </>
  );
}

/** Volume column. Single USD total so cross-token entries are
 *  directly comparable (a price oracle's job — see USD_PRICES above).
 *  Per-token breakdown lives in the expandable detail row so the
 *  cell stays one number. Peers without a `settledVolume` field
 *  (older builds / pre-migration rows) render the offline `—`. */
function VolumeCell({ row }: { row: RankedRelayer }) {
  const volumes = row.stats?.settledVolume ?? [];
  const status = relayerStatsCellStatus(row, volumes.length > 0 ? 1 : undefined);
  if (volumes.length === 0) {
    const tone = status === "offline" ? "text-[var(--color-text-subtle)]" : "";
    return (
      <td className={`px-5 py-3 text-right font-mono ${tone}`} title={statsCellTitle(status)}>
        —
      </td>
    );
  }
  const { total, missing } = sumUsd(volumes);
  const tokenCount = volumes.length;
  return (
    <td className="px-5 py-3 text-right">
      <div className="font-mono font-semibold">{fmtUsd(total)}</div>
      <div className="text-[10px] text-[var(--color-text-subtle)]">
        {tokenCount} token{tokenCount === 1 ? "" : "s"}
        {missing > 0 ? ` · ${missing} unpriced` : ""}
      </div>
    </td>
  );
}

/** Top-3 rank pill (gold / silver / bronze) so the eye lands on the
 *  current leader without a header re-read. Beyond 3 it renders as
 *  plain text — chasing the leaders matters more than knowing whether
 *  you're #7 vs #8. */
function RankBadge({ rank }: { rank: number }) {
  if (rank > 3) return <>{rank}</>;
  const palette =
    rank === 1
      ? "bg-amber-100 text-amber-800 border-amber-300"
      : rank === 2
      ? "bg-slate-100 text-slate-700 border-slate-300"
      : "bg-orange-100 text-orange-800 border-orange-300";
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full border ${palette} text-sm font-bold`}
    >
      {rank}
    </span>
  );
}

/** One-row strip below the table summarising the network-wide totals
 *  the per-row USD columns hint at. Gives the operator a single "what
 *  is the network doing right now" number so they can read the table
 *  as their share of that pie rather than absolute amounts in a
 *  vacuum. */
function NetworkTotalsStrip({ ranked }: { ranked: RankedRelayer[] }) {
  const vols = ranked.flatMap((r) => r.stats?.settledVolume ?? []);
  const fees = ranked.flatMap((r) => r.stats?.feeTotals ?? []);
  if (vols.length === 0 && fees.length === 0) return null;
  const vol = sumUsd(vols);
  const fee = sumUsd(fees);
  const totalSettled = ranked.reduce(
    (n, r) => n + (r.stats?.settledOrders ?? 0),
    0,
  );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
      <span>
        <span className="uppercase tracking-wide text-[var(--color-text-subtle)]">
          Network volume:{" "}
        </span>
        <strong className="font-mono text-[var(--color-text)]">{fmtUsd(vol.total)}</strong>
      </span>
      <span>
        <span className="uppercase tracking-wide text-[var(--color-text-subtle)]">
          Network fee:{" "}
        </span>
        <strong className="font-mono text-[var(--color-success)]">{fmtUsd(fee.total)}</strong>
      </span>
      <span>
        <span className="uppercase tracking-wide text-[var(--color-text-subtle)]">
          Settles:{" "}
        </span>
        <strong className="font-mono text-[var(--color-text)]">{totalSettled}</strong>
      </span>
    </div>
  );
}

/** Color-coded token chip — visual differentiation per token so
 *  the eye can tag rows by asset class at a glance instead of
 *  reading the symbol every time. Palette is keyed off the symbol
 *  (case-insensitive); unknowns get a neutral slate chip. */
function TokenChip({ symbol }: { symbol: string }) {
  const palette: Record<string, string> = {
    ETH: "bg-blue-100 text-blue-800 border-blue-300",
    WETH: "bg-blue-100 text-blue-800 border-blue-300",
    USDC: "bg-emerald-100 text-emerald-800 border-emerald-300",
    USDT: "bg-teal-100 text-teal-800 border-teal-300",
    TON: "bg-amber-100 text-amber-800 border-amber-300",
  };
  const cls = palette[symbol.toUpperCase()] ?? "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {symbol}
    </span>
  );
}

function safeBigInt(s: string): bigint {
  try { return BigInt(s); } catch { return 0n; }
}

/** Revenue (per-token fee earned). Mirrors VolumeCell — every token
 *  stacked vertically — so the "what did this relayer route" vs
 *  "what did it earn" columns line up token-by-token. Falls back to
 *  the same offline `—` shape when the peer doesn't expose feeTotals. */
function RevenueCell({ row }: { row: RankedRelayer }) {
  const totals = row.stats?.feeTotals ?? [];
  const status = relayerStatsCellStatus(row, totals.length > 0 ? 1 : undefined);
  if (totals.length === 0) {
    const tone = status === "offline" ? "text-[var(--color-text-subtle)]" : "";
    return (
      <td className={`px-5 py-3 text-right font-mono ${tone}`} title={statsCellTitle(status)}>
        —
      </td>
    );
  }
  const { total, missing } = sumUsd(totals);
  const tokenCount = totals.length;
  return (
    <td className="px-5 py-3 text-right">
      <div className="font-mono font-semibold text-[var(--color-success)]">{fmtUsd(total)}</div>
      <div className="text-[10px] text-[var(--color-text-subtle)]">
        {tokenCount} token{tokenCount === 1 ? "" : "s"}
        {missing > 0 ? ` · ${missing} unpriced` : ""}
      </div>
    </td>
  );
}

/** Normalize an address string from an untrusted peer's JSON into
 *  the lowercased hex form used as map keys here. Returns `null`
 *  for any input that isn't a parseable address — `ethers.getAddress`
 *  runs full checksum + length validation and throws on garbage,
 *  which we catch so a single bad row from a buggy peer doesn't
 *  break rendering for every other relayer. */
function normAddr(s: unknown): string | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return ethers.getAddress(s).toLowerCase();
  } catch {
    return null;
  }
}

/** Inline expansion row — two SEPARATE per-token tables side-by-side.
 *
 *  Volume is aggregated by sell-leg token (what flowed in via this
 *  relayer's orders); Revenue is aggregated by fee-leg token (what
 *  this relayer earned in fees, which sits on the BUY side of every
 *  match — so it's almost always a different token from the sell
 *  leg). Earlier this was rendered as a single joined table keyed by
 *  token address: a WETH row showed "Volume 1 WETH | Revenue 0.003
 *  WETH" side by side, falsely implying the 0.003 WETH came from
 *  selling that 1 WETH — but those two rows came from DIFFERENT
 *  settles (a sell-side maker fee in one accrues in the buy-token of
 *  another). Splitting them disconnects the columns visually so the
 *  operator can't read causation that isn't there. */
function RelayerDetailRow({ row }: { row: RankedRelayer }) {
  const volumes = row.stats?.settledVolume ?? [];
  const fees = row.stats?.feeTotals ?? [];
  // Sort by USD desc instead of raw wei — 1 WETH and 1 USDC have very
  // different notional values, so a wei-based sort would surface a
  // few thousand wei of WETH above 10,000 USDC. USD makes the ordering
  // actually mean "most impactful to this relayer's revenue".
  const rankByUsd = <T extends { token?: string; sellToken?: string; totalWei?: string; totalVolume?: string }>(
    rows: T[],
  ): T[] => {
    return [...rows].sort((a, b) => {
      const ai = tokenInfo((a.token ?? a.sellToken) ?? "");
      const bi = tokenInfo((b.token ?? b.sellToken) ?? "");
      const av = tokenUsd((a.totalWei ?? a.totalVolume) ?? "0", ai.decimals, ai.symbol) ?? 0;
      const bv = tokenUsd((b.totalWei ?? b.totalVolume) ?? "0", bi.decimals, bi.symbol) ?? 0;
      return bv - av;
    });
  };
  const volRows = rankByUsd(volumes);
  const feeRows = rankByUsd(fees);
  const volTotal = sumUsd(volumes).total;
  const feeTotal = sumUsd(fees).total;
  // Match the colored left-border accent to the rank-badge palette
  // (gold #1 / silver #2 / bronze #3 / neutral 4+) so the eye can
  // trace any open drawer straight back to its parent row at a
  // glance — important when two or more drawers are open and they'd
  // otherwise blur into one another with identical background.
  const accent =
    row.rank === 1
      ? "border-l-amber-400"
      : row.rank === 2
      ? "border-l-slate-400"
      : row.rank === 3
      ? "border-l-orange-400"
      : "border-l-[var(--color-primary)]";
  return (
    <tr className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
      <td colSpan={TABLE_COLUMNS} className={`border-l-4 ${accent} px-5 py-4 shadow-inner`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <span>Per-token breakdown</span>
            <span className="text-[var(--color-text)]">·</span>
            <span className="font-semibold text-[var(--color-text)]">{row.name || `Relayer #${row.rank}`}</span>
            <span className="font-mono text-[10px] text-[var(--color-text-subtle)]">{shortAddr(row.address)}</span>
            {/* One-line help — replaces the per-row paragraph that
                repeated identically beneath every expanded row and
                was the single biggest source of visual noise when
                two drawers were open at once. */}
            <span
              className="ml-1 cursor-help text-[var(--color-text-muted)]"
              title="Volume and Fee are aggregated independently. Cross-token swaps accrue the fee in the buy-side token, so the same token rarely appears with matching numbers on both sides."
            >
              ⓘ
            </span>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          <BreakdownCard
            title="Volume by token"
            subtitle="Sell-leg flow this relayer brought into settlement"
            rows={volRows.map((v) => {
              const info = tokenInfo(v.sellToken);
              const usd = tokenUsd(v.totalVolume, info.decimals, info.symbol);
              return {
                tokenAddr: v.sellToken,
                tokenInfo: info,
                count: v.count,
                native: formatAmount(v.totalVolume, info.decimals),
                usd,
              };
            })}
            total={volTotal}
            countLabel="fills"
            accent="text-[var(--color-text)]"
          />
          <BreakdownCard
            title="Fee by token"
            subtitle="Fees earned (accrues in the buy-leg token of each settle)"
            rows={feeRows.map((f) => {
              const info = tokenInfo(f.token);
              const usd = tokenUsd(f.totalWei, info.decimals, info.symbol);
              return {
                tokenAddr: f.token,
                tokenInfo: info,
                count: f.count,
                native: formatAmount(f.totalWei, info.decimals),
                usd,
              };
            })}
            total={feeTotal}
            countLabel="settles"
            accent="text-[var(--color-success)]"
          />
        </div>
      </td>
    </tr>
  );
}

interface BreakdownRow {
  tokenAddr: string;
  tokenInfo: { symbol: string; decimals: number };
  count: number;
  native: string;
  usd: number | null;
}

/** Initial number of rows shown before the "+ N more" collapse kicks
 *  in. Tokens proliferate fast on a busy relayer (a launch with a
 *  dozen pairs covers 20+ tokens once stables / wrapped variants are
 *  counted); without a cap the drawer would push every row below the
 *  fold. 6 is generous enough that almost every operator sees their
 *  full list without expanding, while still trimming the long tail. */
const BREAKDOWN_VISIBLE_ROWS = 6;

/** One half of the per-token breakdown — either Volume or Revenue.
 *  Kept self-contained so the two halves can render in parallel
 *  without sharing layout state, and so future additions (sparkline,
 *  share-of-network bar) only need to touch one component. Long
 *  token lists collapse after `BREAKDOWN_VISIBLE_ROWS` with a
 *  "+ N more" toggle. */
function BreakdownCard({
  title,
  subtitle,
  rows,
  total,
  countLabel,
  accent,
}: {
  title: string;
  subtitle: string;
  rows: BreakdownRow[];
  total: number;
  countLabel: string;
  accent: string;
}) {
  const [showAll, setShowAll] = useState(false);
  // Per-row USD as a fraction of the card's total — drives the
  // background "share" bar so the eye gauges each token's
  // contribution without computing percentages in its head. Clamp
  // to [0, 1] so a rounding overflow can't render a 101% bar.
  const max = total > 0 ? total : 1;
  const overflow = rows.length - BREAKDOWN_VISIBLE_ROWS;
  const visibleRows = showAll || overflow <= 0 ? rows : rows.slice(0, BREAKDOWN_VISIBLE_ROWS);
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide">{title}</div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">{subtitle}</div>
        </div>
        <div className="text-right">
          <div className={`font-mono text-sm font-semibold ${accent}`}>{fmtUsd(total)}</div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">
            {rows.length} token{rows.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="mt-3 text-xs text-[var(--color-text-muted)]">No activity yet.</div>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {visibleRows.map((r) => {
              const pct = r.usd !== null ? Math.min(1, r.usd / max) : 0;
              const pctLabel = total > 0 && r.usd !== null ? `${Math.round((r.usd / total) * 100)}%` : "";
              return (
                <li key={r.tokenAddr} className="relative">
                  {/* Background "share" bar — width = this row's USD share of the card total.
                      Sits behind the foreground text so it doesn't crowd the numbers; the
                      soft tint keeps it readable on both light and dark themes. */}
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0 rounded bg-[var(--color-primary-soft)] opacity-60"
                    style={{ width: `${pct * 100}%` }}
                  />
                  <div className="relative flex items-center justify-between gap-3 px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <TokenChip symbol={r.tokenInfo.symbol} />
                      <span
                        className="font-mono text-[10px] text-[var(--color-text-subtle)]"
                        title={r.tokenAddr}
                      >
                        {shortAddr(r.tokenAddr)}
                      </span>
                      {pctLabel && (
                        <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-text-muted)]">
                          {pctLabel}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-baseline gap-3 font-mono text-xs">
                      <span className="text-[var(--color-text-muted)]">
                        {r.count} {countLabel}
                      </span>
                      <span>{r.native}</span>
                      <span className="w-16 text-right font-semibold">
                        {r.usd !== null ? fmtUsd(r.usd) : <span className="text-[var(--color-text-subtle)]" title="No price in local oracle">?</span>}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {overflow > 0 && (
            <button
              type="button"
              onClick={(e) => {
                // The parent <tr> is registered as a clickable
                // "expand/collapse" affordance; without stopPropagation,
                // clicking "+ N more" would also collapse the entire
                // drawer the toggle lives inside.
                e.stopPropagation();
                setShowAll((v) => !v);
              }}
              className="mt-2 w-full rounded border border-dashed border-[var(--color-border)] py-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            >
              {showAll ? "Show top 6" : `+ ${overflow} more token${overflow === 1 ? "" : "s"}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Stats-table cell that distinguishes three "no value" states:
 *  live (render the value), unavailable (relayer is up but didn't
 *  return this field — plain `—`), and offline (relayer didn't
 *  respond to `/api/info` at all — muted `—` with a tooltip).
 *  Previously every empty case rendered the same plain `—`, which
 *  hid the difference between a dead relayer and an older build. */
function StatCell({
  row,
  value,
  render,
}: {
  row: RankedRelayer;
  value: number | null | undefined;
  render: (n: number) => string;
}) {
  const status = relayerStatsCellStatus(row, value);
  if (status === "live") {
    return <td className="px-5 py-3 text-right font-mono">{render(value as number)}</td>;
  }
  // "unavailable" reads as a plain `—` matching the surrounding
  // table copy; "offline" gets the subtle tone so a dead relayer
  // visibly stands out from peers that just don't report stats.
  const tone = status === "offline" ? "text-[var(--color-text-subtle)]" : "";
  const title = statsCellTitle(status);
  return (
    <td className={`px-5 py-3 text-right font-mono ${tone}`} title={title}>
      —
    </td>
  );
}

function statsCellTitle(status: StatsCellStatus): string {
  if (status === "offline") return "Relayer offline — /api/info didn't respond";
  return "Relayer online but stats not reported";
}

function RelayerNameCell({ row, isMe }: { row: RankedRelayer; isMe: boolean }) {
  const endpointDisplay = formatEndpointDisplay(row.url);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${row.online ? "bg-[var(--color-success)]" : "bg-[var(--color-text-subtle)]"}`}
          title={row.online ? "API probe ok" : "API probe failed or relayer offline"}
        />
        <Link
          // Query-param route — see relayer/page.tsx and the
          // `output: "export"` convention note in next.config.ts.
          // `target=_blank` so the operator can keep the
          // leaderboard open while drilling into one relayer (the
          // common "compare two relayers" workflow). `rel` blocks
          // window.opener access from the new tab (security
          // hygiene; the destination is a sibling page but the
          // pattern is cheap insurance).
          href={`/relayer?address=${row.address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[var(--color-text)] hover:text-[var(--color-primary)] hover:underline"
        >
          {row.displayName}
        </Link>
        {isMe && (
          <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-[10px] font-medium text-white">
            you
          </span>
        )}
        {row.exitRequestedAt > 0 && (
          <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
            exiting
          </span>
        )}
      </div>
      {endpointDisplay && (
        <span className="ml-4 font-mono text-[11px] text-[var(--color-text-muted)]" title={row.url}>
          {endpointDisplay}
        </span>
      )}
    </div>
  );
}


/** Render a relayer endpoint URL as `host[:port][/path]` — no scheme,
 *  no trailing slash. Uses `new URL()` so the parser handles paths,
 *  query strings, and non-default ports correctly; falls back to a
 *  conservative regex strip when `row.url` isn't a well-formed URL
 *  (legacy registrations may carry a free-form string). */
function formatEndpointDisplay(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const tail = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.host}${tail}`;
  } catch {
    return rawUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}
