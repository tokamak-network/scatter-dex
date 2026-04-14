"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useRouter } from "next/navigation";
import { Globe, RefreshCw, Server, ShoppingBag, Activity, ArrowRightLeft } from "lucide-react";
import {
  getOrders,
  getRelayers,
  getStats,
  isConfigured,
  type SharedOrder,
  type SharedRelayer,
  type SharedOrderbookStats,
} from "../../lib/sharedOrderbook";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import { useRelayers } from "../../lib/useRelayers";

function shortAddr(a: string): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatExpiry(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = ts - now;
  if (delta <= 0) return "expired";
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function SharedOrderbookPage() {
  const [orders, setOrders] = useState<SharedOrder[]>([]);
  const [relayers, setRelayers] = useState<SharedRelayer[]>([]);
  const [stats, setStats] = useState<SharedOrderbookStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [pairFilter, setPairFilter] = useState<string>("all");
  const [submitVia, setSubmitVia] = useState<string>("");
  const router = useRouter();
  const { relayers: registryRelayers } = useRelayers();
  const zkRelayers = useMemo(
    () => registryRelayers.filter((r) => r.online && r.api?.name?.includes("ZK")),
    [registryRelayers],
  );

  useEffect(() => {
    if (!submitVia && zkRelayers.length > 0) setSubmitVia(zkRelayers[0].address);
  }, [submitVia, zkRelayers]);

  const tokens = useMemo(() => getTokenList(), []);
  const tokenByAddr = useMemo(() => {
    const map: Record<string, TokenInfo> = {};
    for (const t of tokens) {
      if (!t.isNative) map[t.address.toLowerCase()] = t;
    }
    return map;
  }, [tokens]);

  const resolveSymbol = useCallback(
    (addr: string): string => tokenByAddr[addr.toLowerCase()]?.symbol || shortAddr(addr),
    [tokenByAddr],
  );
  const resolveDecimals = useCallback(
    (addr: string): number => tokenByAddr[addr.toLowerCase()]?.decimals ?? 18,
    [tokenByAddr],
  );

  /**
   * Build a URL to /trade/private-order that pre-fills a *counter* limit
   * order for the given maker order. To match, the taker must flip
   * sell/buy and the amounts. We also carry maxFee and remaining expiry
   * (rounded up to the next hour) so the signed order can still settle
   * before the maker's order expires.
   */
  const takeOrder = useCallback(
    (o: SharedOrder) => {
      const sellSym = resolveSymbol(o.buyToken);    // I sell what maker wants to buy
      const buySym = resolveSymbol(o.sellToken);    // I buy what maker is selling
      if (!tokenByAddr[o.buyToken.toLowerCase()] || !tokenByAddr[o.sellToken.toLowerCase()]) {
        alert("Cannot take order: one of the tokens is not in this environment's token list.");
        return;
      }
      const sellDec = resolveDecimals(o.sellToken);
      const buyDec = resolveDecimals(o.buyToken);
      const makerSell = parseFloat(ethers.formatUnits(o.sellAmount, sellDec));
      const makerBuy = parseFloat(ethers.formatUnits(o.buyAmount, buyDec));
      // The settle circuit enforces `makerSell × (1 − maxFee) ≥ takerBuy`
      // (and the mirror for the taker side). A naive flip with maxFee > 0
      // always violates this, so prefill with the *net* amounts that
      // actually match:
      //   takerBuy  = makerSell × (1 − fee)  — what taker will receive
      //   takerSell = makerBuy  ÷ (1 − fee)  — gross to cover taker's own fee
      const feeFactor = 1 - o.maxFee / 10000;
      const sellAmt = (makerBuy / feeFactor).toFixed(Math.min(buyDec, 6));
      const buyAmt = (makerSell * feeFactor).toFixed(Math.min(sellDec, 6));
      const remaining = Math.max(1, Math.ceil((o.expiry - Math.floor(Date.now() / 1000)) / 3600));
      const params = new URLSearchParams({
        sell: sellSym,
        buy: buySym,
        sellAmount: sellAmt,
        buyAmount: buyAmt,
        maxFee: String(o.maxFee),
        expiryHours: String(remaining),
      });
      if (submitVia) params.set("relayer", submitVia);
      router.push(`/trade/private-order?${params.toString()}`);
    },
    [resolveSymbol, resolveDecimals, tokenByAddr, submitVia, router],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [o, r, s] = await Promise.all([getOrders(500), getRelayers(), getStats()]);
      setOrders(o);
      setRelayers(r);
      setStats(s);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isConfigured()) refresh();
  }, [refresh]);

  const pairs = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) {
      const [a, b] = [o.sellToken.toLowerCase(), o.buyToken.toLowerCase()].sort();
      set.add(`${a}|${b}`);
    }
    return [...set];
  }, [orders]);

  const filtered = useMemo(() => {
    if (pairFilter === "all") return orders;
    const [a, b] = pairFilter.split("|");
    return orders.filter((o) => {
      const [oa, ob] = [o.sellToken.toLowerCase(), o.buyToken.toLowerCase()].sort();
      return oa === a && ob === b;
    });
  }, [orders, pairFilter]);

  const relayerByAddr = useMemo(() => {
    const map: Record<string, SharedRelayer> = {};
    for (const r of relayers) map[r.address.toLowerCase()] = r;
    return map;
  }, [relayers]);

  if (!isConfigured()) {
    return (
      <div className="p-6 rounded-xl bg-surface-container border border-outline-variant/10">
        <h1 className="text-xl font-headline font-semibold flex items-center gap-2">
          <Globe size={18} /> Shared Orderbook
        </h1>
        <p className="mt-3 text-sm text-on-surface-variant">
          <code>NEXT_PUBLIC_SHARED_ORDERBOOK_URL</code> is not set. Add it to
          <code> frontend/.env.local</code> (e.g. <code>http://localhost:4000</code>)
          and restart the frontend.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-headline font-bold flex items-center gap-2">
            <Globe size={22} /> Shared Orderbook
          </h1>
          <p className="text-sm text-on-surface-variant mt-1">
            Cross-relayer order listings published to the shared marketplace.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-xs font-mono text-on-surface-variant/60">
              updated {lastUpdated.toLocaleTimeString("en-US", { hour12: false })}
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="text-sm flex items-center gap-1.5 px-3 py-1.5 rounded border border-outline-variant/30 hover:bg-surface-bright/50 disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={<ShoppingBag size={16} />} label="Open orders" value={stats?.totalOrders ?? 0} />
        <StatCard icon={<Activity size={16} />} label="Pairs" value={stats?.pairs ?? 0} />
        <StatCard icon={<Server size={16} />} label="Relayers online" value={stats?.relayers ?? 0} />
      </div>

      {/* Pair filter + submit-via relayer */}
      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-3">
          <label className="text-xs uppercase tracking-wide text-on-surface-variant">Pair</label>
          <select
            value={pairFilter}
            onChange={(e) => setPairFilter(e.target.value)}
            className="bg-surface-container-high border border-outline-variant/20 rounded px-3 py-1.5 text-sm"
          >
            <option value="all">All ({orders.length})</option>
            {pairs.map((p) => {
              const [a, b] = p.split("|");
              return (
                <option key={p} value={p}>
                  {resolveSymbol(a)} / {resolveSymbol(b)}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs uppercase tracking-wide text-on-surface-variant">Submit via</label>
          <select
            value={submitVia}
            onChange={(e) => setSubmitVia(e.target.value)}
            disabled={zkRelayers.length === 0}
            className="bg-surface-container-high border border-outline-variant/20 rounded px-3 py-1.5 text-sm font-mono disabled:opacity-40"
          >
            {zkRelayers.length === 0 ? (
              <option value="">No relayers online</option>
            ) : (
              zkRelayers.map((r) => (
                <option key={r.address} value={r.address}>
                  {r.api?.name || "relayer"} — {r.url}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      {/* Orders table */}
      <div className="bg-surface-container rounded-xl border border-outline-variant/10 overflow-hidden">
        <div className="grid grid-cols-[1.2fr_1fr_1.3fr_1.3fr_0.8fr_0.7fr_1fr_0.8fr] text-[10px] uppercase tracking-widest text-on-surface-variant font-bold px-4 py-2.5 border-b border-outline-variant/10 bg-surface-container-high">
          <span>Pair</span>
          <span className="text-right">Price</span>
          <span className="text-right">Sell</span>
          <span className="text-right">Buy</span>
          <span className="text-right">Max fee</span>
          <span className="text-right">Expiry</span>
          <span>Relayer</span>
          <span className="text-right">Action</span>
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-on-surface-variant/60">
            {loading ? "Loading…" : "No orders. Submit a limit order to publish one."}
          </div>
        ) : (
          <div className="divide-y divide-outline-variant/5">
            {filtered.map((o) => {
              const sellSym = resolveSymbol(o.sellToken);
              const buySym = resolveSymbol(o.buyToken);
              const sellDec = resolveDecimals(o.sellToken);
              const buyDec = resolveDecimals(o.buyToken);
              const sell = parseFloat(ethers.formatUnits(o.sellAmount, sellDec));
              const buy = parseFloat(ethers.formatUnits(o.buyAmount, buyDec));
              const feeFactor = 1 - o.maxFee / 10000;
              const sellNet = sell * feeFactor;
              // Effective price = what maker receives per unit of (net) sell.
              const price = sellNet > 0 ? buy / sellNet : 0;
              const relayer = relayerByAddr[o.relayer.toLowerCase()];
              return (
                <div
                  key={o.id}
                  className="grid grid-cols-[1.2fr_1fr_1.3fr_1.3fr_0.8fr_0.7fr_1fr_0.8fr] px-4 py-3 text-sm items-center hover:bg-surface-bright/30"
                >
                  <span className="font-mono">
                    {sellSym} → {buySym}
                  </span>
                  <span className="text-right font-mono">
                    {price.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                  <div className="text-right font-mono leading-tight">
                    <div>{sellNet.toLocaleString(undefined, { maximumFractionDigits: 6 })} {sellSym}</div>
                    <div className="text-[9px] text-on-surface-variant/60">
                      signed {sell.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </div>
                  </div>
                  <span className="text-right font-mono">
                    {buy.toLocaleString(undefined, { maximumFractionDigits: 6 })} {buySym}
                  </span>
                  <span className="text-right font-mono text-on-surface-variant">{(o.maxFee / 100).toFixed(2)}%</span>
                  <span className="text-right font-mono text-on-surface-variant">{formatExpiry(o.expiry)}</span>
                  <span className="text-xs font-mono text-on-surface-variant truncate" title={o.relayer}>
                    {relayer?.name || shortAddr(o.relayer)}
                  </span>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => takeOrder(o)}
                      disabled={zkRelayers.length === 0}
                      className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 disabled:opacity-40 disabled:cursor-default"
                      title="Create a counter limit order pre-filled from this order"
                    >
                      <ArrowRightLeft size={11} />
                      Take
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Relayers list */}
      {relayers.length > 0 && (
        <div className="bg-surface-container rounded-xl border border-outline-variant/10">
          <div className="px-4 py-2.5 border-b border-outline-variant/10 text-xs uppercase tracking-widest text-on-surface-variant font-bold">
            Registered relayers
          </div>
          <div className="divide-y divide-outline-variant/5">
            {relayers.map((r) => (
              <div key={r.address} className="px-4 py-2.5 text-sm grid grid-cols-[1fr_1.5fr_1fr_0.8fr] items-center">
                <span className="font-medium">{r.name || "relayer"}</span>
                <span className="font-mono text-xs text-on-surface-variant" title={r.address}>
                  {shortAddr(r.address)} · {r.url}
                </span>
                <span className="text-on-surface-variant text-xs">
                  {r.orderCount} order{r.orderCount === 1 ? "" : "s"}
                </span>
                <span className="text-on-surface-variant/60 text-xs text-right font-mono">
                  ♥ {new Date(r.lastHeartbeat * 1000).toLocaleTimeString("en-US", { hour12: false })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/10 px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-on-surface-variant">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-headline font-bold">{value}</div>
    </div>
  );
}
