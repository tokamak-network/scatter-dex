"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Loader2, Zap, AlertCircle } from "lucide-react";
import { getBestSwapRoute, type SwapRoute } from "../lib/dex-aggregator";

interface AggregatorQuotePanelProps {
  sellSymbol?: string;
  buySymbol?: string;
  sellTokenAddress?: string;
  buyTokenAddress?: string;
  sellDecimals?: number;
  buyDecimals?: number;
  sellAmount?: string;         // human-readable
  slippageBps?: number;
  account?: string;            // wallet address — required for 1inch's `from`
  chainId?: number;
  /** Called when a new route is fetched — parent uses `estimatedOutput`
   *  and `effectivePrice` to populate the market-order form fields. */
  onQuote?: (q: { estimatedOutput: bigint; effectivePrice: number; source: string } | null) => void;
}

const AGGREGATOR_CHAIN_ID = Number(process.env.NEXT_PUBLIC_AGGREGATOR_CHAIN_ID || 1);

export default function AggregatorQuotePanel({
  sellSymbol,
  buySymbol,
  sellTokenAddress,
  buyTokenAddress,
  sellDecimals,
  buyDecimals,
  sellAmount,
  slippageBps = 50,
  account,
  onQuote,
}: AggregatorQuotePanelProps) {
  const [route, setRoute] = useState<SwapRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  // Debounce-fetch on amount/pair change
  useEffect(() => {
    if (!sellTokenAddress || !buyTokenAddress || !sellAmount || !account || sellDecimals == null || buyDecimals == null) {
      setRoute(null); setError(null); return;
    }
    const parsed = parseFloat(sellAmount);
    if (!isFinite(parsed) || parsed <= 0) { setRoute(null); setError(null); return; }

    let cancelled = false;
    setLoading(true); setError(null);
    const timer = setTimeout(async () => {
      try {
        const sellAmountWei = ethers.parseUnits(sellAmount, sellDecimals);
        const minReceive = 0n; // quote-only panel — execution path enforces real minReceive
        const r = await getBestSwapRoute({
          chainId: AGGREGATOR_CHAIN_ID,
          sellToken: sellTokenAddress,
          buyToken: buyTokenAddress,
          sellAmount: sellAmountWei,
          minReceive,
          recipient: account,
          slippageBps,
        });
        if (!cancelled) {
          setRoute(r);
          setLastFetched(Date.now());
          const price = Number(ethers.formatUnits(r.estimatedOutput, buyDecimals)) / parsed;
          onQuote?.({ estimatedOutput: r.estimatedOutput, effectivePrice: price, source: r.source });
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "quote failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 600);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [sellTokenAddress, buyTokenAddress, sellAmount, sellDecimals, buyDecimals, slippageBps, account]);

  const effectivePrice = route && sellAmount && buyDecimals != null
    ? Number(ethers.formatUnits(route.estimatedOutput, buyDecimals)) / parseFloat(sellAmount)
    : null;

  const estimatedOut = route && buyDecimals != null
    ? Number(ethers.formatUnits(route.estimatedOutput, buyDecimals))
    : null;

  return (
    <div className="bg-surface-container-high rounded-xl border border-outline-variant/10">
      {/* Header */}
      <div className="px-4 py-3 border-b border-outline-variant/10">
        <div className="flex items-center justify-between">
          <h3 className="font-headline font-bold text-lg text-on-surface flex items-center gap-2">
            <Zap className="w-5 h-5 text-tertiary" />
            Aggregator Quote
            <span className="text-xs font-normal text-on-surface-variant">
              {sellSymbol}/{buySymbol}
            </span>
          </h3>
          {lastFetched && (
            <span className="text-[9px] font-mono text-on-surface-variant/50">
              {new Date(lastFetched).toLocaleTimeString("en-US", { hour12: false })}
            </span>
          )}
        </div>
        <p className="text-[9px] text-on-surface-variant/50 mt-0.5">
          Route discovered across 1inch · Uniswap V3 fallback
        </p>
      </div>

      {/* Body */}
      <div className="px-4 py-4 space-y-3">
        {!account && (
          <div className="text-xs text-on-surface-variant/60 text-center py-6">
            Connect wallet to see a live route
          </div>
        )}

        {account && !sellAmount && (
          <div className="text-xs text-on-surface-variant/60 text-center py-6">
            Enter sell amount to request a quote
          </div>
        )}

        {account && sellAmount && loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-on-surface-variant">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Fetching best route…</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-error bg-error/10 border border-error/20 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="text-[11px] break-words">{error}</div>
          </div>
        )}

        {route && !loading && (
          <>
            <QuoteRow label="Source" value={
              <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                route.source === "1inch"
                  ? "bg-tertiary/20 text-tertiary border border-tertiary/30"
                  : "bg-primary/20 text-primary border border-primary/30"
              }`}>{route.source.toUpperCase()}</span>
            } />
            <QuoteRow label="Estimated Output" value={
              <span className="font-mono text-on-surface font-bold">
                {estimatedOut?.toLocaleString("en-US", { maximumFractionDigits: 6 })} {buySymbol}
              </span>
            } />
            <QuoteRow label="Effective Price" value={
              <span className="font-mono text-on-surface">
                {effectivePrice?.toLocaleString("en-US", { maximumFractionDigits: 6 })} {buySymbol}/{sellSymbol}
              </span>
            } />
            <QuoteRow label="Slippage Tolerance" value={
              <span className="font-mono text-on-surface-variant">
                {(slippageBps / 100).toFixed(2)}%
              </span>
            } />
            <div className="pt-2 mt-2 border-t border-outline-variant/10">
              <div className="text-[9px] uppercase tracking-widest text-on-surface-variant font-bold mb-1">Router</div>
              <div className="text-[10px] font-mono text-on-surface-variant/70 break-all">
                {route.dexRouter}
              </div>
            </div>
            <div className="text-[9px] text-on-surface-variant/40 pt-1">
              Calldata length: {Math.ceil((route.dexCalldata.length - 2) / 2)} bytes
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QuoteRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">{label}</span>
      {value}
    </div>
  );
}
