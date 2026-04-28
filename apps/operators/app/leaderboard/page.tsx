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
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { DEMO_NETWORK } from "../lib/network";
import { formatEther, formatIsoDate } from "../lib/format";

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
    loadRelayersWithApiInfo(REGISTRY, readProvider)
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
      <OperatorIdentityBar />
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

      <section>
        <SectionHeader title="Ranking" badge="live" />
        <RelayerTable ranked={ranked} placeholder={placeholder} accountLc={accountLc} />
        <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
          Status dot reflects a live <code className="font-mono">/api/info</code> probe. Settlements,
          success rate, and volume metrics arrive once the shared indexer ships.
        </p>
      </section>
    </div>
  );
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

const TABLE_COLUMNS = 6;

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
      <td className="px-5 py-3 text-right font-mono text-xs text-[var(--color-text-muted)]">
        {formatIsoDate(row.registeredAt)}
      </td>
    </tr>
  );
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
