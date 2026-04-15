"use client";

import { useMemo, useState } from "react";
import { Loader2, AlertCircle, TrendingUp } from "lucide-react";
import { useRelayerTradeStats, type TradeStatsWindow } from "../lib/useRelayerTradeStats";
import { getTokenMap } from "../lib/tokens";
import { formatTokenAmount, shortenAddress, timeAgo } from "../lib/utils";
import SegmentedToggle from "./SegmentedToggle";

const TOP_PAIRS_LIMIT = 5;
const WINDOWS: Array<{ key: TradeStatsWindow; label: string }> = [
  { key: "24h", label: "24h" },
  { key: "7d",  label: "7d"  },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

/**
 * Parse a decimal-string token amount safely. Shared-OB sanitizes to
 * non-negative decimals on write, but a single malformed legacy row
 * shouldn't crash the whole card's render.
 */
function safeBigInt(v: string): bigint | null {
  try { return BigInt(v); } catch { return null; }
}

interface Props {
  address: string;
}

/**
 * Indexer-sourced trade activity for a relayer. Rendered on /relayer/profile
 * alongside the self-reported Performance card. Lives in the shared-OB
 * trust tier ("strong once verified") — stays accurate even when the
 * target relayer is offline, unlike the existing Performance card.
 */
export default function RelayerTradeStats({ address }: Props) {
  const [window, setWindow] = useState<TradeStatsWindow>("7d");
  const { stats, loading, error, unconfigured } = useRelayerTradeStats(address, window);

  const tokenMap = useMemo(() => getTokenMap(), []);
  const tokenSymbol = (addr: string): string =>
    tokenMap[addr.toLowerCase()]?.symbol ?? shortenAddress(addr);
  const tokenDecimals = (addr: string): number =>
    tokenMap[addr.toLowerCase()]?.decimals ?? 18;

  const topPairs = useMemo(() => (stats?.pairs ?? []).slice(0, TOP_PAIRS_LIMIT), [stats]);

  return (
    <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-on-surface flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" /> Trade Activity
          <span className="text-[10px] text-on-surface-variant/40 font-normal">
            (indexer-sourced)
          </span>
        </h2>
        <SegmentedToggle items={WINDOWS} value={window} onChange={setWindow} size="sm" ariaLabel="Time window" />
      </div>

      {unconfigured ? (
        <p className="text-xs text-on-surface-variant/40">
          Trade activity requires the shared orderbook indexer to be configured.
        </p>
      ) : loading && !stats ? (
        <div className="flex items-center gap-2 py-6 justify-center text-on-surface-variant/50 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading trade activity…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-on-surface-variant/40">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      ) : !stats || stats.txCount === 0 ? (
        <p className="text-xs text-on-surface-variant/40">
          No settlements attributed to this relayer in the selected window.
        </p>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <Tile label="Settlements" value={String(stats.txCount)} />
            <Tile
              label="Verified"
              value={String(stats.txCountVerified)}
              color={stats.txCountVerified > 0 ? "text-emerald-400" : undefined}
            />
            <Tile
              label="Success rate"
              value={stats.successRate === null ? "—" : `${(stats.successRate * 100).toFixed(1)}%`}
              sub={stats.successRate === null ? "pending verification" : undefined}
            />
            <Tile
              label="Avg fee"
              value={stats.avgFeeBps === null ? "—" : `${stats.avgFeeBps.toFixed(1)} bps`}
              sub="realised, per side"
            />
          </div>

          {/* Top pairs */}
          {topPairs.length > 0 && (
            <div className="mb-5">
              <div className="text-[10px] uppercase tracking-wider text-on-surface-variant/40 mb-2">
                Top pairs
              </div>
              <div className="flex flex-wrap gap-1.5">
                {topPairs.map((p) => (
                  <span
                    key={`${p.sellToken}-${p.buyToken}`}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-container text-[11px] font-mono text-on-surface-variant"
                  >
                    {tokenSymbol(p.sellToken)} → {tokenSymbol(p.buyToken)}
                    <span className="text-on-surface-variant/40">({p.count})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Volume by token */}
          {stats.volumeByToken.length > 0 && (
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wider text-on-surface-variant/40 mb-2">
                Volume by token
              </div>
              {/* overflow-x-auto + min-width lets the fixed-column grid
                  scroll horizontally on mobile rather than clipping or
                  squashing amounts. */}
              <div className="overflow-x-auto -mx-1">
                <div className="min-w-[540px] px-1 space-y-1">
                  <div className="grid grid-cols-[1fr_100px_100px_100px_100px] gap-2 text-[10px] text-on-surface-variant/30 uppercase tracking-wider px-3 py-1">
                    <span>Token</span>
                    <span className="text-right">Sold</span>
                    <span className="text-right">Bought</span>
                    <span className="text-right">Sell#</span>
                    <span className="text-right">Buy#</span>
                  </div>
                  {stats.volumeByToken.map((v) => {
                    const dec = tokenDecimals(v.token);
                    const sellBig = safeBigInt(v.totalSell);
                    const buyBig = safeBigInt(v.totalBuy);
                    return (
                      <div
                        key={v.token}
                        className="grid grid-cols-[1fr_100px_100px_100px_100px] gap-2 px-3 py-1.5 text-xs hover:bg-surface-bright/20 rounded transition-colors"
                      >
                        <span className="font-bold text-on-surface">{tokenSymbol(v.token)}</span>
                        <span className="text-right font-mono text-on-surface-variant/80">
                          {sellBig === null ? "—" : formatTokenAmount(sellBig, dec)}
                        </span>
                        <span className="text-right font-mono text-on-surface-variant/80">
                          {buyBig === null ? "—" : formatTokenAmount(buyBig, dec)}
                        </span>
                        <span className="text-right font-mono text-on-surface-variant/60">{v.sellCount}</span>
                        <span className="text-right font-mono text-on-surface-variant/60">{v.buyCount}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {stats.lastSettleAt !== null && (
            <div className="text-[10px] text-on-surface-variant/40">
              Last settlement {timeAgo(stats.lastSettleAt)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-surface-container rounded-lg px-4 py-3">
      <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-bold mt-1 ${color ?? "text-on-surface"}`}>{value}</div>
      {sub && <div className="text-[9px] text-on-surface-variant/40 mt-0.5">{sub}</div>}
    </div>
  );
}
