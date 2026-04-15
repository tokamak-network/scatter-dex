"use client";

import { useEffect, useRef } from "react";
import { RefreshCw, Star } from "lucide-react";
import { useMainnetPrice, getRecommendedPrice } from "../lib/useDexPrices";

interface PricePanelProps {
  sellSymbol?: string;
  buySymbol?: string;
  side?: "buy" | "sell";
  /** Called when a price is selected (click or auto-recommend) */
  onSelectPrice?: (price: string) => void;
  /** When true, skip the "apply recommended price on first load" behavior.
   *  Used by deep-links (e.g. Shared Orderbook Take) that already pre-fill
   *  sell/buy amounts and must not be overwritten by the DEX recommendation. */
  disableAutoApply?: boolean;
}

export default function PricePanel({
  sellSymbol,
  buySymbol,
  side,
  onSelectPrice,
  disableAutoApply,
}: PricePanelProps) {
  // ── DEX prices (mainnet) — fetch on mount + manual refresh ──
  const { prices: dexPrices, refresh: refreshDex, lastUpdated } = useMainnetPrice(sellSymbol, buySymbol, side);
  const dexLoading = dexPrices.some((d) => d.loading);

  // Auto-apply recommended price on first load
  const appliedRef = useRef(false);
  useEffect(() => {
    if (disableAutoApply) return;
    if (appliedRef.current) return;
    const rec = getRecommendedPrice(dexPrices);
    if (rec !== null && onSelectPrice) {
      onSelectPrice(rec.toFixed(4));
      appliedRef.current = true;
    }
  }, [dexPrices, onSelectPrice, disableAutoApply]);

  // Reset auto-apply when pair changes
  useEffect(() => {
    appliedRef.current = false;
  }, [sellSymbol, buySymbol]);

  const handleSelect = (price: number) => {
    onSelectPrice?.(price.toFixed(4));
  };

  return (
    <div className="bg-surface-container-high rounded-xl border border-outline-variant/10">
      {/* Header */}
      <div className="px-4 py-3 border-b border-outline-variant/10">
        <div className="flex items-center justify-between">
          <h3 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
            Price Reference
            <span className="text-[10px] font-normal text-on-surface-variant">
              {sellSymbol}/{buySymbol}
            </span>
            <span className="text-[9px] font-normal px-1.5 py-0.5 rounded bg-surface-container-low text-on-surface-variant">
              Mainnet
            </span>
          </h3>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-[9px] font-mono text-on-surface-variant/50">
                {lastUpdated.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
            <button
              type="button"
              onClick={refreshDex}
              disabled={dexLoading}
              className="text-[10px] flex items-center gap-1 px-2 py-0.5 rounded border border-outline-variant/20 text-on-surface-variant hover:bg-surface-bright/50 disabled:opacity-40 disabled:cursor-default"
              title="Refresh prices"
            >
              <RefreshCw size={10} className={dexLoading ? "animate-spin" : undefined} />
              Refresh
            </button>
          </div>
        </div>
        <p className="text-[9px] text-on-surface-variant/50 mt-0.5">
          {side === "buy" ? "Lowest net price recommended" : "Highest net price recommended"}
          {" · manual refresh"}
        </p>
      </div>

      {/* DEX prices with fee */}
      <div className="px-4 py-3 space-y-1 border-b border-outline-variant/10">
        {/* Column header */}
        <div className="grid grid-cols-[1fr_80px_60px] text-[9px] uppercase tracking-widest text-on-surface-variant font-bold pb-1">
          <span>Source</span>
          <span className="text-right">Price</span>
          <span className="text-right">Fee</span>
        </div>
        {dexPrices.map((d) => (
          <button
            key={d.source}
            onClick={() => d.netPrice !== null && handleSelect(d.netPrice)}
            disabled={d.netPrice === null}
            className={`w-full grid grid-cols-[1fr_80px_60px] items-center py-1.5 px-2 rounded-md transition-colors disabled:opacity-40 disabled:cursor-default ${
              d.recommended
                ? "bg-primary/10 border border-primary/30"
                : "hover:bg-surface-bright/50"
            }`}
          >
            <div className="flex items-center gap-2">
              {d.recommended ? (
                <Star className="w-3 h-3 text-primary fill-primary" />
              ) : (
                <div className={`w-1.5 h-1.5 rounded-full ${d.netPrice !== null ? "bg-tertiary" : d.loading ? "bg-on-surface-variant animate-pulse" : "bg-outline-variant/30"}`} />
              )}
              <span className={`text-xs ${d.recommended ? "text-primary font-bold" : "text-on-surface-variant"}`}>
                {d.source}
                {d.referenceOnly && <span className="text-[8px] ml-1 opacity-50">ref</span>}
              </span>
            </div>
            <span className={`text-xs font-mono text-right ${d.recommended ? "text-primary font-bold" : "text-on-surface font-bold"}`}>
              {d.loading ? "..." : d.netPrice !== null ? d.netPrice.toFixed(4) : d.error || "—"}
            </span>
            <span className="text-[10px] font-mono text-right text-on-surface-variant">
              {d.fee || "—"}
            </span>
          </button>
        ))}

        {onSelectPrice && (
          <p className="text-[9px] text-on-surface-variant/40 text-center pt-1">Click a price to use it</p>
        )}
      </div>
    </div>
  );
}
