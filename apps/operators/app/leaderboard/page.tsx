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
import { formatEther, formatIsoDate } from "../lib/format";
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
    compare: (a, b) =>
      compareNullable(usdTotal(a.stats?.settledVolume), usdTotal(b.stats?.settledVolume), true),
  },
  {
    id: "revenue",
    label: "Revenue",
    description: "Highest USD-equivalent fee earned first",
    compare: (a, b) =>
      compareNullable(usdTotal(a.stats?.feeTotals), usdTotal(b.stats?.feeTotals), true),
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
          Cross-token sums need a price oracle, so Volume / Revenue are shown per token
          and rank by the relayer&apos;s biggest single token.
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
}

function rankRelayers(
  rows: RelayerInfo[],
  criterion: RankCriterion,
): RankedRelayer[] {
  // Two-pass: project the per-row metadata first (display name, etc.)
  // so the comparator works against a known-shape RankedRelayer and
  // doesn't allocate fresh objects on every comparison.
  const projected: RankedRelayer[] = rows.map((r) => ({
    ...r,
    rank: 0,
    displayName: relayerDisplayName(r),
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

const TABLE_COLUMNS = 11;

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
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg)] text-xs">
          <tr>
            <SortableTh label="#" column="" criterion={null} align="left" />
            <SortableTh label="Relayer" column="" criterion={null} align="left" />
            <SortableTh label="Address" column="" criterion={null} align="left" />
            <SortableTh label="Fee rate" column="fee" criterion="fee" />
            <SortableTh label="Bond" column="bond" criterion="bond" />
            <SortableTh label="Settled" column="settled" criterion="activity" />
            <SortableTh label="Volume" column="volume" criterion="volume" />
            <SortableTh label="Revenue" column="revenue" criterion="revenue" />
            <SortableTh label="Success" column="success" criterion="success" />
            <SortableTh label="Avg settle" column="speed" criterion="speed" />
            <SortableTh label="Registered" column="" criterion={null} />
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
        <td className="px-5 py-3 text-right font-mono text-xs text-[var(--color-text-muted)]">
          {formatIsoDate(row.registeredAt)}
        </td>
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
          Network revenue:{" "}
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

/** Inline expansion row — joins per-token settled volume and per-token
 *  fee earned on the token address so the operator can read both
 *  metrics on the same line per token without scanning two columns. */
function RelayerDetailRow({ row }: { row: RankedRelayer }) {
  const volumes = row.stats?.settledVolume ?? [];
  const fees = row.stats?.feeTotals ?? [];
  const tokens = new Map<string, { volume?: typeof volumes[number]; fee?: typeof fees[number] }>();
  for (const v of volumes) {
    const k = normAddr(v.sellToken);
    if (!k) continue;
    tokens.set(k, { ...(tokens.get(k) ?? {}), volume: v });
  }
  for (const f of fees) {
    const k = normAddr(f.token);
    if (!k) continue;
    tokens.set(k, { ...(tokens.get(k) ?? {}), fee: f });
  }
  // Sort by volume notional desc, then by fee notional desc — matches
  // the order the parent cells render so the eye lands in the same place.
  const rows = Array.from(tokens.entries()).sort(([, a], [, b]) => {
    const av = safeBigInt(a.volume?.totalVolume ?? "0");
    const bv = safeBigInt(b.volume?.totalVolume ?? "0");
    if (av !== bv) return av > bv ? -1 : 1;
    const af = safeBigInt(a.fee?.totalWei ?? "0");
    const bf = safeBigInt(b.fee?.totalWei ?? "0");
    return af === bf ? 0 : af > bf ? -1 : 1;
  });
  return (
    <tr className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
      <td colSpan={TABLE_COLUMNS} className="px-5 py-4">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          Per-token breakdown
        </div>
        <table className="mt-2 w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-3 py-1 text-left">Token</th>
              {/* "Fills" — not "Settled" — because a single cross-token
                  settleAuth contributes one fill to BOTH tokens (sell
                  + buy leg). Reusing the top-level "Settled" label
                  would invite the obvious-but-wrong sum across rows.
                  The tooltip explains the per-leg semantics. */}
              <th
                className="px-3 py-1 text-right"
                title="Per-token fills: a cross-token settle contributes one fill to each side; a same-token Pay scatter contributes one fill to that token. Summing across tokens won't match the row's Settled total."
              >
                Fills
              </th>
              <th className="px-3 py-1 text-right">Volume (native)</th>
              <th className="px-3 py-1 text-right">Volume (USD)</th>
              <th className="px-3 py-1 text-right">Revenue (native)</th>
              <th className="px-3 py-1 text-right">Revenue (USD)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([addr, { volume, fee }]) => {
              const info = tokenInfo(addr);
              const volUsd = volume ? tokenUsd(volume.totalVolume, info.decimals, info.symbol) : null;
              const feeUsd = fee ? tokenUsd(fee.totalWei, info.decimals, info.symbol) : null;
              return (
                <tr key={addr} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-1.5">
                    <TokenChip symbol={info.symbol} />{" "}
                    <span className="font-mono text-[10px] text-[var(--color-text-subtle)]">
                      {shortAddr(addr)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {volume?.count ?? 0}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {volume ? formatAmount(volume.totalVolume, info.decimals) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {volUsd !== null ? fmtUsd(volUsd) : <span className="text-[var(--color-text-subtle)]" title="No price in local oracle">?</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {fee ? formatAmount(fee.totalWei, info.decimals) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {feeUsd !== null ? fmtUsd(feeUsd) : <span className="text-[var(--color-text-subtle)]" title="No price in local oracle">?</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </td>
    </tr>
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
          href={`/relayer?address=${row.address}`}
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
