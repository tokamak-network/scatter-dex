"use client";

import Link from "next/link";
import {
  Vault, Loader2, AlertCircle, ArrowLeft, ArrowDownToLine, Coins, RefreshCw,
} from "lucide-react";
import {
  usePlatformRevenue,
  PLATFORM_REVENUE_SOURCES,
  RECENT_WITHDRAWAL_LIMIT,
} from "../../lib/usePlatformRevenue";
import { shortenAddress, formatTokenAmount } from "../../lib/utils";

export default function TreasuryPage() {
  const data = usePlatformRevenue();

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link href="/relayer" className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Dashboard
      </Link>

      {/* Header card */}
      <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <Vault className="w-7 h-7 text-tertiary" />
            <div>
              <h1 className="text-xl font-headline font-bold text-on-surface">Platform Treasury</h1>
              <p className="text-xs text-on-surface-variant/60 mt-0.5">
                Lifetime revenue accrued by the protocol across all settlement paths.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {data.fromBlock != null && (
              <span className="text-[10px] text-on-surface-variant/40" title="Lifetime totals are computed from FeeVault events scanned from this block onward. If NEXT_PUBLIC_DEPLOY_BLOCK isn't configured the scan starts at latest − 50 000, so older activity is not counted.">
                scanned from #{data.fromBlock}
              </span>
            )}
            <button
              type="button"
              onClick={data.refetch}
              disabled={data.loading}
              className="flex items-center gap-1 text-[10px] text-on-surface-variant hover:text-primary disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              <RefreshCw size={11} className={data.loading ? "animate-spin" : undefined} /> Refresh
            </button>
          </div>
        </div>

        {data.treasury && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-outline-variant/10">
            <div>
              <div className="text-xs text-on-surface-variant/50">Treasury address</div>
              <div className="text-sm font-mono text-on-surface mt-0.5">{shortenAddress(data.treasury)}</div>
            </div>
            <div>
              <div className="text-xs text-on-surface-variant/50">Relayer-claim platform fee</div>
              <div className="text-sm font-bold text-on-surface mt-0.5">
                {data.platformFeeBps != null ? `${(data.platformFeeBps / 100).toFixed(2)}%` : "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {data.loading && (
        <div className="flex items-center justify-center py-10 text-on-surface-variant/50 text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading treasury data...
        </div>
      )}

      {data.error && (
        <div className="glass-card rounded-xl p-6 border border-outline-variant/10 flex items-center gap-2 text-sm text-on-surface-variant/60">
          <AlertCircle className="w-4 h-4" /> {data.error}
        </div>
      )}

      {/* Per-token accumulated + lifetime withdrawn */}
      {!data.loading && !data.error && (
        <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
          <h2 className="text-sm font-bold text-on-surface mb-4 flex items-center gap-2">
            <Coins className="w-4 h-4 text-tertiary" /> Per-token balances (DEX paths only)
          </h2>
          {data.rows.length === 0 ? (
            <p className="text-xs text-on-surface-variant/40">No platform revenue accrued yet.</p>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_140px_140px] gap-2 text-[10px] text-on-surface-variant/30 uppercase tracking-wider px-3 py-1">
                <span>Token</span>
                <span className="text-right">Currently held</span>
                <span className="text-right">Lifetime withdrawn</span>
              </div>
              {data.rows.map((row) => (
                <div key={row.token} className="grid grid-cols-[1fr_140px_140px] gap-2 px-3 py-2 text-xs hover:bg-surface-bright/20 rounded transition-colors">
                  <span className="font-bold text-on-surface">{row.symbol}</span>
                  <span className="text-right font-mono text-on-surface">{formatTokenAmount(row.accumulated, row.decimals)}</span>
                  <span className="text-right font-mono text-on-surface-variant/70">{formatTokenAmount(row.lifetimeWithdrawn, row.decimals)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[10px] text-on-surface-variant/40">
            Relayer-claim skim is wired straight to treasury and never lands in this bucket — see the by-source view below for that stream.
          </p>
        </div>
      )}

      {/* Source breakdown */}
      {!data.loading && !data.error && (
        <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
          <h2 className="text-sm font-bold text-on-surface mb-4">Lifetime revenue by source</h2>
          {data.bySource.every((s) => s.entries.length === 0) ? (
            <p className="text-xs text-on-surface-variant/40">No revenue events found in scan range.</p>
          ) : (
            <div className="space-y-4">
              {data.bySource.map((s) => {
                const label = PLATFORM_REVENUE_SOURCES.find((p) => p.id === s.source)?.label ?? s.source;
                return (
                  <div key={s.source}>
                    <div className="text-[11px] font-semibold text-on-surface-variant/60 mb-1">{label}</div>
                    {s.entries.length === 0 ? (
                      <div className="text-[11px] text-on-surface-variant/30 px-3">—</div>
                    ) : (
                      <div className="space-y-0.5">
                        {s.entries.map((e) => (
                          <div key={e.token} className="grid grid-cols-[80px_1fr] gap-2 px-3 py-1 text-[11px]">
                            <span className="text-on-surface-variant/70">{e.symbol}</span>
                            <span className="font-mono text-on-surface">{formatTokenAmount(e.amount, e.decimals)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Recent withdrawals */}
      {!data.loading && !data.error && data.recentWithdrawals.length > 0 && (
        <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
          <h2 className="text-sm font-bold text-on-surface mb-4 flex items-center gap-2">
            <ArrowDownToLine className="w-4 h-4 text-amber-400" />
            Recent treasury sweeps (last {RECENT_WITHDRAWAL_LIMIT})
          </h2>
          <div className="space-y-1">
            <div className="grid grid-cols-[120px_1fr_140px] gap-2 text-[10px] text-on-surface-variant/30 uppercase tracking-wider px-3 py-1">
              <span>Block</span>
              <span>Tx hash</span>
              <span className="text-right">Amount</span>
            </div>
            {data.recentWithdrawals.map((w) => (
              <div key={`${w.txHash}-${w.logIndex}`} className="grid grid-cols-[120px_1fr_140px] gap-2 px-3 py-1.5 text-[11px] hover:bg-surface-bright/20 rounded transition-colors">
                <span className="font-mono text-on-surface-variant/40">#{w.blockNumber}</span>
                <span className="font-mono text-primary truncate">{w.txHash}</span>
                <span className="text-right font-mono text-on-surface">{formatTokenAmount(w.amount, w.decimals)} {w.symbol}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-center text-[10px] text-on-surface-variant/20 font-mono break-all pb-8">
        FeeVault events: PlatformFeeFromDex · PlatformSurplusFromDex · PlatformFeeFromRelayerClaim · PlatformRevenueWithdrawn
      </div>
    </div>
  );
}
