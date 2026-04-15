"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Trophy, RefreshCw, AlertCircle, Loader2, Crown } from "lucide-react";
import { useRelayers } from "../../lib/useRelayers";
import {
  useLeaderboard,
  type LeaderboardMetric,
  type LeaderboardWindow,
} from "../../lib/useLeaderboard";
import { shortenAddress, timeAgo } from "../../lib/utils";
import RelayerLogo from "../../components/RelayerLogo";
import SegmentedToggle from "../../components/SegmentedToggle";

const METRICS: Array<{ key: LeaderboardMetric; label: string; help: string }> = [
  { key: "count",         label: "Settlements",   help: "Total settlements where the relayer appears in any role" },
  { key: "verifiedCount", label: "Verified",      help: "Subset confirmed on-chain by the verify job" },
  { key: "successRate",   label: "Success rate",  help: "Verified ÷ total. Only relayers with at least one verified settlement appear." },
];

const WINDOWS: Array<{ key: LeaderboardWindow; label: string }> = [
  { key: "24h", label: "24h" },
  { key: "7d",  label: "7d"  },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

const RANK_COLORS = ["text-amber-400", "text-gray-300", "text-amber-700"] as const;
const rankIconColor = (rank: number): string => RANK_COLORS[rank] ?? "text-on-surface-variant/30";

export default function LeaderboardPage() {
  const [metric, setMetric] = useState<LeaderboardMetric>("count");
  const [windowKey, setWindowKey] = useState<LeaderboardWindow>("7d");
  const { rows, loading, error, unconfigured } = useLeaderboard(metric, windowKey);
  const { relayers } = useRelayers();

  // Join leaderboard rows (settlement activity) with on-chain registry
  // info (bond / fee / url + the operator-set profile name + logo).
  const relayerByAddr = useMemo(() => {
    const m = new Map<string, (typeof relayers)[number]>();
    for (const r of relayers) m.set(r.address.toLowerCase(), r);
    return m;
  }, [relayers]);

  const enriched = useMemo(() => rows.map((row) => {
    const reg = relayerByAddr.get(row.address.toLowerCase());
    return {
      ...row,
      profile: reg?.api?.profile,
      url: reg?.url,
      online: reg?.online ?? false,
      bond: reg?.bond,
      fee: reg?.fee,
      registered: !!reg,
    };
  }), [rows, relayerByAddr]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3">
            <Trophy className="w-7 h-7 text-primary" />
            Leaderboard
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            Top relayers by settlement activity. Sourced from the shared orderbook indexer.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <SegmentedToggle items={METRICS} value={metric} onChange={setMetric} ariaLabel="Ranking metric" />
        <SegmentedToggle items={WINDOWS} value={windowKey} onChange={setWindowKey} ariaLabel="Time window" />
        {loading && <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant/50" />}
      </div>

      {/* States */}
      {unconfigured ? (
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-8 text-center text-on-surface-variant/70">
          <AlertCircle className="w-8 h-8 mx-auto mb-3 opacity-50" />
          <p className="text-sm">Set <code className="px-1.5 py-0.5 rounded bg-surface text-primary font-mono">NEXT_PUBLIC_SHARED_ORDERBOOK_URL</code> to enable the leaderboard.</p>
        </div>
      ) : error ? (
        <div className="bg-surface-container rounded-xl border border-error/30 p-6 text-sm text-error/80 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      ) : enriched.length === 0 && !loading ? (
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-8 text-center text-on-surface-variant/60">
          <RefreshCw className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            No settlements in the selected window
            {metric === "successRate" && " with any verified rows"}.
          </p>
        </div>
      ) : (
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="text-left px-4 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium w-12">#</th>
                <th className="text-left px-4 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Relayer</th>
                <th className="text-right px-4 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Settlements</th>
                <th className="text-right px-4 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Verified</th>
                <th className="text-right px-4 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Success</th>
                <th className="text-right px-4 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((row, i) => {
                const successPct = row.txCount > 0
                  ? (row.txCountVerified / row.txCount) * 100
                  : null;
                return (
                  <tr
                    key={row.address}
                    className="border-b border-outline-variant/5 hover:bg-surface-bright/20 transition-colors last:border-0"
                  >
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-sm font-bold">
                        {i < 3 ? <Crown className={`w-3.5 h-3.5 ${rankIconColor(i)}`} /> : null}
                        <span className={i < 3 ? rankIconColor(i) : "text-on-surface-variant/50"}>
                          {i + 1}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/relayer/profile?address=${row.address}`}
                        className="flex items-center gap-2 group"
                      >
                        <RelayerLogo logoUrl={row.profile?.logoUrl} size={24} />
                        <div>
                          <div className="text-sm text-on-surface group-hover:text-primary transition-colors">
                            {row.profile?.name ?? shortenAddress(row.address)}
                          </div>
                          <div className="text-[10px] text-on-surface-variant/40 font-mono">
                            {shortenAddress(row.address)}
                            {!row.registered && <span className="ml-2 text-amber-500">(not in registry)</span>}
                          </div>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono text-on-surface">{row.txCount}</td>
                    <td className="px-4 py-3 text-right text-sm font-mono text-emerald-400">{row.txCountVerified}</td>
                    <td className="px-4 py-3 text-right text-sm font-mono text-on-surface-variant/70">
                      {successPct === null ? "—" : `${successPct.toFixed(1)}%`}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-on-surface-variant/60">
                      {row.lastSettleAt ? timeAgo(row.lastSettleAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
