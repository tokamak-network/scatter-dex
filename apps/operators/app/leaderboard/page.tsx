"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import {
  loadRelayersWithApiInfo,
  unwrapEthersError,
  type RelayerInfo,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { SectionHeader } from "../components/SectionHeader";
import { DEMO_NETWORK } from "../lib/network";
import { formatEther, formatIsoDate } from "../lib/format";
import { relayerStatsCellStatus, type StatsCellStatus } from "../lib/relayerStatus";

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;

interface LeaderboardState {
  loading: boolean;
  rows: RelayerInfo[];
  error: string | null;
}

export default function LeaderboardPage() {
  const { account, readProvider } = useWallet();
  const registryDeployed = isConfiguredAddress(REGISTRY);
  const [state, setState] = useState<LeaderboardState>({ loading: false, rows: [], error: null });

  useEffect(() => {
    if (!registryDeployed) {
      setState({ loading: false, rows: [], error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadRelayersWithApiInfo(REGISTRY, readProvider, { withStats: true })
      .then((rows) => { if (!cancelled) setState({ loading: false, rows, error: null }); })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load leaderboard", e);
        setState({ loading: false, rows: [], error: unwrapEthersError(e) });
      });
    return () => { cancelled = true; };
  }, [registryDeployed, readProvider]);

  const accountLc = account?.toLowerCase() ?? null;
  const ranked = useMemo(() => rankRelayers(state.rows), [state.rows]);
  const placeholder = leaderboardPlaceholder(state, registryDeployed);
  const me = accountLc ? ranked.find((r) => r.address.toLowerCase() === accountLc) : undefined;
  const medianFeeBps = ranked.length > 0 ? medianBps(ranked.map((r) => r.fee)) : null;

  return (
    <div className="space-y-10">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leaderboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Network-wide relayer ranking from the on-chain registry. Ranked by
            bond posted (descending), per-trade fee as tiebreaker. Your relayer
            is highlighted.
          </p>
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
        <SectionHeader title="Ranking" badge="live" />
        <RelayerTable ranked={ranked} placeholder={placeholder} accountLc={accountLc} />
        <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
          Status dot reflects a live <code className="font-mono">/api/info</code> probe. Settlement
          counters and avg-settle latency come from each peer&apos;s public{" "}
          <code className="font-mono">/api/relayer/stats</code> — older builds without the endpoint
          fall back to <code className="font-mono">—</code>.
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

function rankRelayers(rows: RelayerInfo[]): RankedRelayer[] {
  return [...rows]
    .sort((a, b) => {
      if (a.bond !== b.bond) return b.bond > a.bond ? 1 : -1;
      return a.fee - b.fee;
    })
    .map((r, i) => ({ ...r, rank: i + 1, displayName: relayerDisplayName(r) }));
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

const TABLE_COLUMNS = 9;

function RelayerTable({
  ranked,
  placeholder,
  accountLc,
}: {
  ranked: RankedRelayer[];
  placeholder: Placeholder | null;
  accountLc: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-5 py-3 text-left">#</th>
            <th className="px-5 py-3 text-left">Relayer</th>
            <th className="px-5 py-3 text-left">Address</th>
            <th className="px-5 py-3 text-right">Fee</th>
            <th className="px-5 py-3 text-right">Bond</th>
            <th className="px-5 py-3 text-right">Settled</th>
            <th className="px-5 py-3 text-right">Success</th>
            <th className="px-5 py-3 text-right">Avg settle</th>
            <th className="px-5 py-3 text-right">Registered</th>
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

function RelayerRow({ row, isMe }: { row: RankedRelayer; isMe: boolean }) {
  return (
    <tr className={`border-t border-[var(--color-border)] ${isMe ? "bg-[var(--color-primary-soft)]" : ""}`}>
      <td className="px-5 py-3 font-semibold">{row.rank}</td>
      <td className="px-5 py-3">
        <RelayerNameCell row={row} isMe={isMe} />
      </td>
      <td className="px-5 py-3 font-mono text-xs text-[var(--color-text-muted)]">{shortAddr(row.address)}</td>
      <td className="px-5 py-3 text-right">{(row.fee / 100).toFixed(2)}%</td>
      <td className="px-5 py-3 text-right font-mono">{formatEther(row.bond)} ETH</td>
      <StatCell row={row} value={row.stats?.settledOrders} render={(n) => String(n)} />
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
  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2 w-2 rounded-full ${row.online ? "bg-[var(--color-success)]" : "bg-[var(--color-text-subtle)]"}`}
        title={row.online ? "API probe ok" : "API probe failed or relayer offline"}
      />
      <span className="font-medium">{row.displayName}</span>
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
  );
}
