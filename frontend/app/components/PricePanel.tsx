"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { ethers } from "ethers";
import { Loader2, RefreshCw, Star } from "lucide-react";
import { useMainnetPrice, getRecommendedPrice, type DexPrice } from "../lib/useDexPrices";
import { RelayerClient, type OrderbookEntry } from "../lib/relayerApi";

interface BookLevel {
  price: number;
  amount: number;
  maker: string;
}

interface PricePanelProps {
  sellSymbol?: string;
  buySymbol?: string;
  sellTokenAddress?: string;
  buyTokenAddress?: string;
  sellDecimals?: number;
  buyDecimals?: number;
  relayerUrl?: string;
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
  sellTokenAddress,
  buyTokenAddress,
  sellDecimals,
  buyDecimals,
  relayerUrl,
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

  // ── zkScatter orderbook ──
  const [bookAsks, setBookAsks] = useState<BookLevel[]>([]);
  const [bookBids, setBookBids] = useState<BookLevel[]>([]);
  const [bookLoading, setBookLoading] = useState(false);

  useEffect(() => {
    if (!sellTokenAddress || !buyTokenAddress || !relayerUrl || sellDecimals == null || buyDecimals == null) return;
    let cancelled = false;
    // Sort addresses to match relayer's pairKey() convention
    const [addrA, addrB] = [sellTokenAddress, buyTokenAddress].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const pair = `${addrA}-${addrB}`;
    const client = new RelayerClient(relayerUrl);

    const fetchBook = async () => {
      setBookLoading(true);
      try {
        const data = await client.getOrderbook(pair);
        if (cancelled) return;
        const toLevel = (e: OrderbookEntry): BookLevel => {
          const sell = parseFloat(ethers.formatUnits(e.sellAmount, sellDecimals!));
          const buy = parseFloat(ethers.formatUnits(e.buyAmount, buyDecimals!));
          return { price: buy / sell, amount: sell, maker: e.maker };
        };
        setBookAsks(data.sells.map(toLevel).sort((a, b) => a.price - b.price).slice(0, 8));
        setBookBids(data.buys.map(toLevel).sort((a, b) => b.price - a.price).slice(0, 8));
      } catch {
        if (!cancelled) { setBookAsks([]); setBookBids([]); }
      } finally {
        if (!cancelled) setBookLoading(false);
      }
    };

    fetchBook();
    const interval = setInterval(fetchBook, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sellTokenAddress, buyTokenAddress, sellDecimals, buyDecimals, relayerUrl]);

  const handleSelect = (price: number) => {
    onSelectPrice?.(price.toFixed(4));
  };

  const bookMid = useMemo(() => {
    if (bookBids.length > 0 && bookAsks.length > 0) return (bookBids[0].price + bookAsks[0].price) / 2;
    if (bookBids.length > 0) return bookBids[0].price;
    if (bookAsks.length > 0) return bookAsks[0].price;
    return null;
  }, [bookBids, bookAsks]);

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

        {/* zkScatter book mid-price (no swap fee — internal settlement) */}
        <button
          onClick={() => bookMid !== null && handleSelect(bookMid)}
          disabled={bookMid === null}
          className="w-full grid grid-cols-[1fr_80px_60px] items-center py-1.5 px-2 rounded-md hover:bg-surface-bright/50 transition-colors disabled:opacity-40 disabled:cursor-default"
        >
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${bookMid !== null ? "bg-primary" : "bg-outline-variant/30"}`} />
            <span className="text-xs text-on-surface-variant">zkScatter Book</span>
          </div>
          <span className="text-xs font-mono text-right text-on-surface font-bold">
            {bookMid !== null ? bookMid.toFixed(4) : "—"}
          </span>
          <span className="text-[10px] font-mono text-right text-tertiary">0%</span>
        </button>

        {onSelectPrice && (
          <p className="text-[9px] text-on-surface-variant/40 text-center pt-1">Click a price to use it</p>
        )}
      </div>

      {/* Orderbook — Upbit style */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Order Book</span>
          {bookLoading && <Loader2 className="w-3 h-3 animate-spin text-on-surface-variant" />}
        </div>

        <div className="grid grid-cols-3 text-[9px] uppercase tracking-widest text-on-surface-variant font-bold pb-1 border-b border-outline-variant/10">
          <span>Price</span>
          <span className="text-right">Amount</span>
          <span className="text-right">Total</span>
        </div>

        {/* Asks */}
        <div className="max-h-[140px] overflow-y-auto flex flex-col-reverse">
          {bookAsks.length > 0 ? (() => {
            const maxAskAmt = Math.max(...bookAsks.map((x) => x.amount), 1);
            return bookAsks.map((a, i) => (
              <button
                key={`ask-${i}`}
                onClick={() => handleSelect(a.price)}
                className="relative grid grid-cols-3 px-0 py-[3px] text-[11px] font-mono hover:bg-error/10 transition-colors"
              >
                <div className="absolute inset-y-0 right-0 bg-error/8" style={{ width: `${(a.amount / maxAskAmt) * 100}%` }} />
                <span className="relative text-error">{a.price.toFixed(4)}</span>
                <span className="relative text-right text-on-surface-variant">{a.amount.toFixed(4)}</span>
                <span className="relative text-right text-on-surface-variant">{(a.price * a.amount).toFixed(2)}</span>
              </button>
            ));
          })() : (
            <div className="py-2 text-[10px] text-on-surface-variant/50 text-center">No asks</div>
          )}
        </div>

        {/* Spread */}
        <div className="py-1.5 border-y border-outline-variant/10 flex items-center justify-center gap-2">
          {bookBids.length > 0 && bookAsks.length > 0 ? (
            <>
              <span className="text-xs font-mono font-bold text-on-surface">
                {((bookBids[0].price + bookAsks[0].price) / 2).toFixed(4)}
              </span>
              <span className="text-[10px] text-on-surface-variant">
                spread {((bookAsks[0].price - bookBids[0].price) / bookAsks[0].price * 100).toFixed(2)}%
              </span>
            </>
          ) : (
            <span className="text-[10px] text-on-surface-variant/50">—</span>
          )}
        </div>

        {/* Bids */}
        <div className="max-h-[140px] overflow-y-auto">
          {bookBids.length > 0 ? (() => {
            const maxBidAmt = Math.max(...bookBids.map((x) => x.amount), 1);
            return bookBids.map((b, i) => (
              <button
                key={`bid-${i}`}
                onClick={() => handleSelect(b.price)}
                className="relative grid grid-cols-3 px-0 py-[3px] text-[11px] font-mono w-full text-left hover:bg-tertiary/10 transition-colors"
              >
                <div className="absolute inset-y-0 right-0 bg-tertiary/8" style={{ width: `${(b.amount / maxBidAmt) * 100}%` }} />
                <span className="relative text-tertiary">{b.price.toFixed(4)}</span>
                <span className="relative text-right text-on-surface-variant">{b.amount.toFixed(4)}</span>
                <span className="relative text-right text-on-surface-variant">{(b.price * b.amount).toFixed(2)}</span>
              </button>
            ));
          })() : (
            <div className="py-2 text-[10px] text-on-surface-variant/50 text-center">No bids</div>
          )}
        </div>
      </div>
    </div>
  );
}
