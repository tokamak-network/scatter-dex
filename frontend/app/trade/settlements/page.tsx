"use client";

import { useMemo, useState } from "react";
import { RefreshCw, AlertCircle, Loader2, Activity, Zap, ArrowLeftRight } from "lucide-react";
import { useRecentSettlements, type SettlementPath, type SettlementRow } from "../../lib/useRecentSettlements";
import { getTokenMap } from "../../lib/tokens";
import { shortenAddress, formatTokenAmount, timeAgo } from "../../lib/utils";

const PATH_FILTERS: { id: "all" | SettlementPath; label: string }[] = [
  { id: "all", label: "All" },
  { id: "p2p", label: "P2P" },
  { id: "dex", label: "DEX" },
];

export default function SettlementsPage() {
  const { rows, loading, error, refresh } = useRecentSettlements(100);
  const [pathFilter, setPathFilter] = useState<"all" | SettlementPath>("all");
  const [tokenQuery, setTokenQuery] = useState("");

  const tokenMap = useMemo(() => getTokenMap(), []);

  const filtered = useMemo(() => {
    const q = tokenQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (pathFilter !== "all" && r.path !== pathFilter) return false;
      if (!q) return true;
      // Token query matches DEX rows only — P2P rows don't carry pair info
      // on the event, so filtering them by symbol would always drop them.
      if (r.path !== "dex") return false;
      const sell = r.sellToken ? tokenMap[r.sellToken.toLowerCase()]?.symbol.toLowerCase() ?? "" : "";
      const buy = r.buyToken ? tokenMap[r.buyToken.toLowerCase()]?.symbol.toLowerCase() ?? "" : "";
      return sell.includes(q) || buy.includes(q);
    });
  }, [rows, pathFilter, tokenQuery, tokenMap]);

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" aria-hidden="true" />
            Settlements
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            Every on-chain settlement from this deployment — both P2P (<code>settleAuth</code>) and DEX swaps (<code>settleWithDex</code>). Read-only.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-surface-container hover:bg-surface-bright/60 border border-outline-variant/20 text-sm text-on-surface disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div role="group" aria-label="Filter by settlement path" className="inline-flex rounded-md bg-surface-container p-0.5 border border-outline-variant/20">
          {PATH_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setPathFilter(f.id)}
              aria-pressed={pathFilter === f.id}
              className={`px-3 py-1.5 text-sm rounded ${
                pathFilter === f.id ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={tokenQuery}
          onChange={(e) => setTokenQuery(e.target.value)}
          placeholder="Filter by token symbol — hides P2P rows (no pair in event)"
          aria-label="Filter DEX rows by token symbol"
          className="flex-1 min-w-[240px] bg-surface-container border border-outline-variant/20 rounded-md px-3 py-1.5 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
        />
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 p-3 rounded-md bg-error-container/20 border border-error/30 text-sm text-error">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>Failed to load settlements: {error}</span>
        </div>
      )}

      <div className="bg-surface-container/50 rounded-xl border border-outline-variant/10 overflow-x-auto">
        <table aria-label="Recent settlements" className="w-full text-sm">
          <thead className="bg-surface-bright/30 text-on-surface-variant/80 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Block</th>
              <th className="text-left px-4 py-3 font-semibold">Path</th>
              <th className="text-left px-4 py-3 font-semibold">Pair / Amount</th>
              <th className="text-left px-4 py-3 font-semibold">Relayer / Submitter</th>
              <th className="text-left px-4 py-3 font-semibold">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/10">
            {loading && filtered.length === 0 && (
              <tr><td colSpan={5} role="status" aria-live="polite" className="px-4 py-10 text-center text-on-surface-variant/60">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" aria-hidden="true" /> Loading…
              </td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-on-surface-variant/60">
                No settlements match the current filters.
              </td></tr>
            )}
            {filtered.map((r) => (
              <SettlementTableRow key={`${r.txHash}-${r.logIndex}`} row={r} tokenMap={tokenMap} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-on-surface-variant/50 mt-3">
        P2P rows don&apos;t include the token pair or amount — those live in the tx calldata, not the event. Copy the tx hash into a block explorer to see full details.
      </p>
    </div>
  );
}

function SettlementTableRow({ row, tokenMap }: { row: SettlementRow; tokenMap: Record<string, { symbol: string; decimals: number }> }) {
  const sell = row.sellToken ? tokenMap[row.sellToken.toLowerCase()] : undefined;
  const buy = row.buyToken ? tokenMap[row.buyToken.toLowerCase()] : undefined;
  const when = row.timestamp ? timeAgo(row.timestamp) : "—";
  return (
    <tr className="hover:bg-surface-bright/20">
      <td className="px-4 py-3 align-top">
        <div className="font-mono text-on-surface">{row.blockNumber}</div>
        <div className="text-xs text-on-surface-variant/60">{when}</div>
      </td>
      <td className="px-4 py-3 align-top">
        {row.path === "dex" ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-container/40 text-primary text-xs">
            <Zap className="w-3 h-3" aria-hidden="true" /> DEX
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary-container/40 text-secondary text-xs">
            <ArrowLeftRight className="w-3 h-3" aria-hidden="true" /> P2P
          </span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {row.path === "dex" && sell && buy && row.sellAmount != null && row.amountOut != null ? (
          <div className="text-on-surface">
            {formatTokenAmount(row.sellAmount, sell.decimals)} <span className="text-on-surface-variant/70">{sell.symbol}</span>
            {" → "}
            {formatTokenAmount(row.amountOut, buy.decimals)} <span className="text-on-surface-variant/70">{buy.symbol}</span>
          </div>
        ) : (
          <span className="text-on-surface-variant/50">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top font-mono text-xs text-on-surface-variant" title={row.participant}>
        {shortenAddress(row.participant)}
      </td>
      <td className="px-4 py-3 align-top font-mono text-xs text-primary" title={row.txHash}>
        {shortenAddress(row.txHash)}
      </td>
    </tr>
  );
}
