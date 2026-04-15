"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { Radio, ExternalLink, Loader2, AlertCircle, RefreshCw, Circle, Globe, BarChart3, User, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useRelayers, type RelayerInfo, type RelayerOrderbook } from "../lib/useRelayers";
import { getTokenList, type TokenInfo } from "../lib/tokens";
import { shortenAddress, formatBond, timeAgo } from "../lib/utils";
import SharedOrderbookStatus from "../components/SharedOrderbookStatus";
import { getOrders, type SharedRelayer, type SharedOrder } from "../lib/sharedOrderbook";

function feeBps(fee: number): string {
  return `${(fee / 100).toFixed(2)}%`;
}

// ─── Helpers ─────────────────────────────────────────────────
type SortKey = "status" | "fee" | "pending" | "bond" | "registered";

function SortableHeader({
  k, sortKey, sortDir, onClick, children,
}: {
  k: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onClick: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = sortKey === k;
  return (
    <th className="text-left px-4 py-2.5 font-semibold">
      <button
        type="button"
        onClick={() => onClick(k)}
        className={`inline-flex items-center gap-1 transition-colors ${
          active ? "text-on-surface" : "hover:text-on-surface"
        }`}
      >
        {children}
        {active && (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
      </button>
    </th>
  );
}

function buildPairOptions(tokens: TokenInfo[]) {
  const erc20 = tokens.filter((t) => !t.isNative);
  const pairs: { label: string; value: string }[] = [];
  for (let i = 0; i < erc20.length; i++) {
    for (let j = i + 1; j < erc20.length; j++) {
      const [tokenLow, tokenHigh] = [erc20[i], erc20[j]].sort((t1, t2) =>
        t1.address.toLowerCase().localeCompare(t2.address.toLowerCase()),
      );
      const a = tokenLow.address.toLowerCase();
      const b = tokenHigh.address.toLowerCase();
      pairs.push({ label: `${tokenLow.symbol}/${tokenHigh.symbol}`, value: `${a}-${b}` });
    }
  }
  for (const t of erc20) {
    const addr = t.address.toLowerCase();
    pairs.push({ label: `${t.symbol} Scatter`, value: `${addr}-${addr}` });
  }
  return pairs;
}

type PriceLevel = { price: string; priceNum: number; qty: number };

function aggregateOrderbook(
  orderbooks: RelayerOrderbook[],
  tokens: TokenInfo[],
  pair: string,
): { asks: PriceLevel[]; bids: PriceLevel[] } {
  const findToken = (addr: string) => tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());
  const pts = pair.split("-");
  const tA = findToken(pts[0]);
  const tB = findToken(pts[1]);
  const dA = tA?.decimals ?? 18;
  const dB = tB?.decimals ?? 18;

  const formatPrice = (val: number): string => {
    if (val === 0) return "0";
    if (val >= 1) return val.toFixed(4);
    const digits = Math.max(4, -Math.floor(Math.log10(Math.abs(val))) + 4);
    return val.toFixed(digits);
  };

  const calcPrice = (baseAmt: string, quoteAmt: string, baseDec: number, quoteDec: number) => {
    const base = Number(ethers.formatUnits(baseAmt, baseDec));
    const quote = Number(ethers.formatUnits(quoteAmt, quoteDec));
    return base > 0 ? formatPrice(quote / base) : "0";
  };

  const askMap = new Map<string, number>();
  const bidMap = new Map<string, number>();

  for (const ob of orderbooks) {
    for (const o of ob.sells) {
      const price = calcPrice(o.sellAmount, o.buyAmount, dA, dB);
      const qty = Number(ethers.formatUnits(o.sellAmount, dA));
      askMap.set(price, (askMap.get(price) ?? 0) + qty);
    }
    for (const o of ob.buys) {
      const price = calcPrice(o.buyAmount, o.sellAmount, dA, dB);
      const qty = Number(ethers.formatUnits(o.buyAmount, dA));
      bidMap.set(price, (bidMap.get(price) ?? 0) + qty);
    }
  }

  const asks = Array.from(askMap.entries())
    .map(([price, qty]) => ({ price, priceNum: parseFloat(price), qty }))
    .sort((a, b) => a.priceNum - b.priceNum);

  const bids = Array.from(bidMap.entries())
    .map(([price, qty]) => ({ price, priceNum: parseFloat(price), qty }))
    .sort((a, b) => b.priceNum - a.priceNum);

  return { asks, bids };
}

// ─── Orderbook Display ───────────────────────────────────────
function OrderbookDisplay({ asks, bids, symA, symB }: {
  asks: PriceLevel[];
  bids: PriceLevel[];
  symA: string;
  symB: string;
}) {
  const maxAskQty = Math.max(...asks.map((a) => a.qty), 0.001);
  const maxBidQty = Math.max(...bids.map((b) => b.qty), 0.001);
  const isEmpty = asks.length === 0 && bids.length === 0;

  if (isEmpty) {
    return <div className="text-xs text-on-surface-variant/30 text-center py-10">No orders</div>;
  }

  return (
    <div>
      <div className="grid grid-cols-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider px-3 py-2">
        <span className="text-right">Qty ({symA})</span>
        <span className="text-center">Price ({symB})</span>
        <span className="text-left">Qty ({symA})</span>
      </div>
      <div className="max-h-[280px] overflow-y-auto">
        {[...asks].reverse().map((a, i) => (
          <div key={`a-${i}`} className="grid grid-cols-3 items-center px-3 py-[4px] text-xs hover:bg-error/5 transition-colors">
            <div className="relative text-right pr-1">
              <div className="absolute right-0 top-0 bottom-0 bg-error/8 rounded-l" style={{ width: `${(a.qty / maxAskQty) * 100}%` }} />
              <span className="relative font-mono text-on-surface-variant/70">{a.qty.toFixed(4)}</span>
            </div>
            <span className="text-center font-mono text-error">{a.price}</span>
            <span />
          </div>
        ))}
        {asks.length > 0 && bids.length > 0 && (
          <div className="flex items-center justify-center py-1.5 border-y border-outline-variant/10 my-0.5">
            <span className="text-[10px] text-on-surface-variant/40">
              spread {(asks[0].priceNum - bids[0].priceNum).toFixed(2)} {symB}
            </span>
          </div>
        )}
        {bids.map((b, i) => (
          <div key={`b-${i}`} className="grid grid-cols-3 items-center px-3 py-[4px] text-xs hover:bg-primary/5 transition-colors">
            <span />
            <span className="text-center font-mono text-primary">{b.price}</span>
            <div className="relative text-left pl-1">
              <div className="absolute left-0 top-0 bottom-0 bg-primary/8 rounded-r" style={{ width: `${(b.qty / maxBidQty) * 100}%` }} />
              <span className="relative font-mono text-on-surface-variant/70">{b.qty.toFixed(4)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────
export default function RelayersPage() {
  const { relayers: allRelayers, loading, error, refresh } = useRelayers();
  const relayers = allRelayers;
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  // Default sort: status desc → online relayers first; address acts as the
  // deterministic tiebreak so equal-status rows don't reshuffle on rerender.
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [orderbooks, setOrderbooks] = useState<Map<string, Map<string, RelayerOrderbook>>>(new Map());
  const [obLoading, setObLoading] = useState(false);

  // Shared orderbook state
  const [sharedRelayers, setSharedRelayers] = useState<SharedRelayer[]>([]);
  const sharedRelayerMap = useMemo(() => {
    const m = new Map<string, SharedRelayer>();
    for (const r of sharedRelayers) m.set(r.address.toLowerCase(), r);
    return m;
  }, [sharedRelayers]);
  const [obViewMode, setObViewMode] = useState<"local" | "global">("local");
  const [globalOrders, setGlobalOrders] = useState<SharedOrder[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);

  const globalLoadingRef = React.useRef(false);
  const loadGlobalOrders = useCallback(async () => {
    if (globalLoadingRef.current) return;
    globalLoadingRef.current = true;
    setGlobalLoading(true);
    try {
      const orders = await getOrders(500);
      setGlobalOrders(orders);
    } catch { /* silent */ }
    setGlobalLoading(false);
    globalLoadingRef.current = false;
  }, []);

  const tokens = useMemo(() => getTokenList(), []);
  const pairOptions = useMemo(() => buildPairOptions(tokens), [tokens]);
  const findToken = (addr: string) => tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());

  const onlineRelayers = useMemo(() => relayers.filter((r) => r.online), [relayers]);
  // Lowercase comparison matches the rest of the file (sharedRelayerMap,
  // findToken, profile/page.tsx) so future deep-links like
  // `?selected=0xABC...` work regardless of input casing.
  const selected = useMemo(
    () => selectedAddress
      ? relayers.find((r) => r.address.toLowerCase() === selectedAddress.toLowerCase()) ?? null
      : null,
    [selectedAddress, relayers],
  );

  // Build per-relayer × per-pair orderbook view by filtering the shared
  // orderbook in a single fetch. Each relayer publishes its open orders
  // to shared OB, so filtering by `relayer` reconstructs the per-relayer
  // book without per-relayer endpoints.
  const loadOrderbooks = useCallback(async (target: RelayerInfo | null) => {
    const targets = target && target.online ? [target] : onlineRelayers;
    if (targets.length === 0 || pairOptions.length === 0) return;
    setObLoading(true);

    let allOrders: SharedOrder[] = [];
    try {
      allOrders = await getOrders(500);
    } catch { /* shared OB unreachable — leave books empty */ }

    // Pre-group orders by `(relayer, sellToken-buyToken)` in one pass so
    // the (relayer × pair) loop below is O(R·P) lookups instead of
    // R·P·2 linear scans of `allOrders`. `maker` carries the EdDSA
    // pubKeyAx (per-trader identifier) — the wallet address never
    // appears in shared OB summaries.
    type Entry = { maker: string; sellAmount: string; buyAmount: string };
    const ordersByRelayerAndPair = new Map<string, Map<string, Entry[]>>();
    for (const o of allOrders) {
      const relayerKey = o.relayer.toLowerCase();
      const pairKey = `${o.sellToken.toLowerCase()}-${o.buyToken.toLowerCase()}`;
      let pairMap = ordersByRelayerAndPair.get(relayerKey);
      if (!pairMap) {
        pairMap = new Map();
        ordersByRelayerAndPair.set(relayerKey, pairMap);
      }
      const list = pairMap.get(pairKey);
      const entry = { maker: o.pubKeyAx, sellAmount: o.sellAmount, buyAmount: o.buyAmount };
      if (list) list.push(entry); else pairMap.set(pairKey, [entry]);
    }

    const results = new Map<string, Map<string, RelayerOrderbook>>();
    for (const r of targets) {
      const pairResults = new Map<string, RelayerOrderbook>();
      const relayerPairOrders = ordersByRelayerAndPair.get(r.address.toLowerCase());
      for (const p of pairOptions) {
        const [tA, tB] = p.value.split("-").map((s) => s.toLowerCase());
        const sells = relayerPairOrders?.get(`${tA}-${tB}`) ?? [];
        const buys = relayerPairOrders?.get(`${tB}-${tA}`) ?? [];
        pairResults.set(p.value, { pair: p.value, sells, buys });
      }
      results.set(r.address, pairResults);
    }

    setOrderbooks(results);
    setObLoading(false);
  }, [onlineRelayers, pairOptions]);

  useEffect(() => {
    if (relayers.length > 0 && pairOptions.length > 0) {
      loadOrderbooks(selected);
    }
  }, [selected, relayers.length, pairOptions.length, loadOrderbooks]);

  // Get orderbooks for right panel
  function getOrderbookForPair(pair: string) {
    const obs: RelayerOrderbook[] = [];
    if (selected) {
      const pairMap = orderbooks.get(selected.address);
      if (pairMap?.has(pair)) obs.push(pairMap.get(pair)!);
    } else {
      for (const pairMap of orderbooks.values()) {
        if (pairMap.has(pair)) obs.push(pairMap.get(pair)!);
      }
    }
    return aggregateOrderbook(obs, tokens, pair);
  }

  // Count total orders for a relayer
  function relayerOrderCount(r: RelayerInfo): number {
    return r.api?.orderCount ?? 0;
  }

  // Address is the deterministic tiebreak so equal-value rows don't
  // reshuffle on rerender.
  const sortedRelayers = useMemo(() => {
    const dirMul = sortDir === "asc" ? 1 : -1;
    const addrTiebreak = (a: RelayerInfo, b: RelayerInfo) => a.address.localeCompare(b.address);
    return [...relayers].sort((a, b) => {
      let primary = 0;
      switch (sortKey) {
        // Treat online > offline so dirMul applies uniformly: status desc
        // (default) puts online first; status asc puts offline first.
        case "status":     primary = a.online === b.online ? 0 : a.online ? 1 : -1; break;
        case "fee":        primary = a.fee - b.fee; break;
        case "pending":    primary = relayerOrderCount(a) - relayerOrderCount(b); break;
        case "bond":       primary = a.bond > b.bond ? 1 : a.bond < b.bond ? -1 : 0; break;
        case "registered": primary = a.registeredAt - b.registeredAt; break;
      }
      return primary === 0 ? addrTiebreak(a, b) : primary * dirMul;
    });
  }, [relayers, sortKey, sortDir]);

  // Pick each column's natural default direction so first click is intuitive
  // (cheap fees first, large bonds first, etc.); same-key click flips.
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "fee" || key === "registered" ? "asc" : "desc");
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3">
            <Radio className="w-7 h-7 text-primary" />
            Relayer Dashboard
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            {relayers.length} registered &middot; {onlineRelayers.length} online
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-xs text-on-surface hover:bg-surface-bright/50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Shared Orderbook Status */}
      <SharedOrderbookStatus onRelayersLoaded={setSharedRelayers} />

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-error-container/10 border border-error/20 text-error text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {loading && relayers.length === 0 && (
        <div className="flex items-center justify-center py-20 text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading from registry...
        </div>
      )}

      {!loading && !error && relayers.length === 0 && (
        <div className="text-center py-20 text-on-surface-variant/60">
          <Radio className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No active relayers found</p>
        </div>
      )}

      {relayers.length > 0 && (
        <div className="space-y-5">
          {/* ─── Network summary banner ─── */}
          <button
            onClick={() => setSelectedAddress(null)}
            className={`w-full rounded-xl border px-5 py-3 text-left transition-all ${
              selectedAddress === null
                ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                : "border-outline-variant/15 bg-surface-container hover:bg-surface-bright/30"
            }`}
          >
            <div className="flex items-center gap-3 flex-wrap">
              <Globe className="w-4 h-4 text-primary flex-shrink-0" />
              <span className="text-sm font-semibold text-on-surface">All Network</span>
              <span className="text-[11px] text-on-surface-variant/60">{onlineRelayers.length} online</span>
              <span className="text-[11px] text-on-surface-variant/60">
                {onlineRelayers.reduce((s, r) => s + relayerOrderCount(r), 0)} pending
              </span>
              <span className="text-[11px] text-on-surface-variant/60">
                {formatBond(relayers.reduce((s, r) => s + r.bond, 0n))} bonded
              </span>
            </div>
          </button>

          {/* ─── Comparison table ─── */}
          <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-on-surface-variant/50 border-b border-outline-variant/10">
                  <th className="text-left px-4 py-2.5 font-semibold">Relayer</th>
                  <SortableHeader k="status" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Status</SortableHeader>
                  <SortableHeader k="fee" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Fee</SortableHeader>
                  <SortableHeader k="pending" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Pending</SortableHeader>
                  <SortableHeader k="bond" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Bond</SortableHeader>
                  <SortableHeader k="registered" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Registered</SortableHeader>
                  <th className="text-left px-4 py-2.5 font-semibold">Shared OB</th>
                  <th className="text-right px-4 py-2.5 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedRelayers.map((r) => {
                  const shared = sharedRelayerMap.get(r.address.toLowerCase());
                  const isSelected = selectedAddress?.toLowerCase() === r.address.toLowerCase();
                  return (
                    <tr
                      key={r.address}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedAddress(r.address)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedAddress(r.address); } }}
                      className={`border-b border-outline-variant/5 last:border-0 cursor-pointer transition-colors focus:outline-none focus:ring-1 focus:ring-primary/40 ${
                        isSelected ? "bg-primary/8" : "hover:bg-surface-bright/30"
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-on-surface">{shortenAddress(r.address)}</span>
                          {r.api?.name?.includes("ZK") && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-tertiary/20 text-tertiary font-bold">ZK</span>
                          )}
                        </div>
                        {r.online && r.url && (
                          <div className="text-[10px] text-on-surface-variant/40 font-mono mt-0.5 truncate max-w-[240px]">
                            {r.url}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs ${r.online ? "text-primary" : "text-error/60"}`}>
                          <Circle className="w-2 h-2 fill-current" />
                          {r.online ? "online" : "offline"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-on-surface-variant/80">{feeBps(r.fee)}</td>
                      <td className="px-4 py-3 text-on-surface-variant/80">{relayerOrderCount(r)}</td>
                      <td className="px-4 py-3 text-on-surface-variant/80">{formatBond(r.bond)}</td>
                      <td className="px-4 py-3 text-on-surface-variant/60 text-xs">{timeAgo(r.registeredAt)}</td>
                      <td className="px-4 py-3 text-xs">
                        {shared ? (
                          <span className="text-on-surface-variant/60">
                            {shared.orderCount} · hb {timeAgo(shared.lastHeartbeat)}
                          </span>
                        ) : (
                          <span className="text-on-surface-variant/30">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/relayer/profile?address=${r.address}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary-container"
                        >
                          <User className="w-3 h-3" /> Profile
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ─── Detail / orderbook panel ─── */}
          <div className="space-y-4">
            {/* Detail bar */}
            {selected && (
              <div className="flex items-center gap-4 px-4 py-3 bg-surface-container rounded-xl border border-outline-variant/10 text-xs">
                <Circle className={`w-2.5 h-2.5 fill-current flex-shrink-0 ${selected.online ? "text-primary" : "text-error/40"}`} />
                <span className="font-mono text-on-surface">{selected.address}</span>
                {selected.online && selected.url ? (
                  <a href={`${selected.url}/api/info`} target="_blank" rel="noreferrer"
                    className="text-primary hover:underline flex items-center gap-1">
                    API <ExternalLink className="w-3 h-3" />
                  </a>
                ) : (
                  <span className="text-on-surface-variant/40 flex items-center gap-1" title="Relayer is offline or has no URL registered">
                    API <ExternalLink className="w-3 h-3" />
                  </span>
                )}
                {selected.api && (
                  <span className="text-on-surface-variant/50 ml-auto">
                    {selected.api.name} v{selected.api.version}
                  </span>
                )}
              </div>
            )}

            {!selected && (
              <div className="px-4 py-3 bg-surface-container rounded-xl border border-outline-variant/10 text-xs text-on-surface-variant/60 flex items-center gap-2">
                <Globe className="w-4 h-4 text-primary" />
                Aggregated orderbook across all {onlineRelayers.length} online relayers
              </div>
            )}

            {/* Orderbook view mode tabs */}
            {sharedRelayers.length > 0 && (
              <div className="flex gap-1 mb-3">
                <button
                  onClick={() => setObViewMode("local")}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                    obViewMode === "local"
                      ? "bg-primary/15 text-primary"
                      : "text-on-surface-variant/60 hover:text-on-surface-variant"
                  }`}
                >
                  Local
                </button>
                <button
                  onClick={() => {
                    setObViewMode("global");
                    loadGlobalOrders();
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                    obViewMode === "global"
                      ? "bg-primary/15 text-primary"
                      : "text-on-surface-variant/60 hover:text-on-surface-variant"
                  }`}
                >
                  Global
                </button>
              </div>
            )}

            {(obLoading || globalLoading) && (
              <div className="flex items-center justify-center py-8 text-on-surface-variant/50 text-sm">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading orderbooks...
              </div>
            )}

            {/* Local orderbook per pair */}
            {!obLoading && !globalLoading && obViewMode === "local" && pairOptions.length > 0 && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {pairOptions.map((p) => {
                  const pts = p.value.split("-");
                  const symA = findToken(pts[0])?.symbol ?? "?";
                  const symB = findToken(pts[1])?.symbol ?? "?";
                  const { asks, bids } = getOrderbookForPair(p.value);
                  const totalOrders = asks.length + bids.length;

                  return (
                    <div key={p.value} className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-2.5 border-b border-outline-variant/10">
                        <span className="text-sm font-semibold text-on-surface">{p.label}</span>
                        <span className="text-[10px] text-on-surface-variant/40">
                          {totalOrders} order{totalOrders !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="py-1">
                        <OrderbookDisplay asks={asks} bids={bids} symA={symA} symB={symB} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Global orderbook (shared orderbook) */}
            {!globalLoading && obViewMode === "global" && (
              <div className="space-y-3">
                {globalOrders.length === 0 ? (
                  <div className="text-xs text-on-surface-variant/30 text-center py-10">
                    No orders on shared orderbook
                  </div>
                ) : (
                  <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
                    {/* Pre-compute relayer lookup map for O(1) access per row */}
                    <div className="grid grid-cols-[1fr_1fr_80px_80px_100px] gap-2 px-4 py-2.5 border-b border-outline-variant/10 text-[10px] text-on-surface-variant/40 uppercase tracking-wider">
                      <span>Sell</span>
                      <span>Buy</span>
                      <span className="text-right">Fee</span>
                      <span className="text-right">Expiry</span>
                      <span className="text-right">Relayer</span>
                    </div>
                    <div className="max-h-[400px] overflow-y-auto">
                      {globalOrders.map((o) => {
                        const sellSym = findToken(o.sellToken)?.symbol ?? shortenAddress(o.sellToken);
                        const buySym = findToken(o.buyToken)?.symbol ?? shortenAddress(o.buyToken);
                        const sellDec = findToken(o.sellToken)?.decimals ?? 18;
                        const buyDec = findToken(o.buyToken)?.decimals ?? 18;
                        const sellFmt = Number(ethers.formatUnits(o.sellAmount, sellDec)).toFixed(4);
                        const buyFmt = Number(ethers.formatUnits(o.buyAmount, buyDec)).toFixed(4);
                        const shared = sharedRelayerMap.get(o.relayer.toLowerCase());
                        const expiresIn = o.expiry - Math.floor(Date.now() / 1000);
                        const expiryStr = expiresIn <= 0 ? "Expired" : expiresIn > 3600 ? `${Math.floor(expiresIn / 3600)}h` : expiresIn > 60 ? `${Math.floor(expiresIn / 60)}m` : `${expiresIn}s`;

                        return (
                          <div key={o.id} className="grid grid-cols-[1fr_1fr_80px_80px_100px] gap-2 px-4 py-2 text-xs hover:bg-surface-bright/20 transition-colors border-b border-outline-variant/5">
                            <span className="font-mono text-error">{sellFmt} {sellSym}</span>
                            <span className="font-mono text-tertiary">{buyFmt} {buySym}</span>
                            <span className="text-right text-on-surface-variant/60">{(o.maxFee / 100).toFixed(2)}%</span>
                            <span className="text-right text-on-surface-variant/60">{expiryStr}</span>
                            <span className="text-right text-[10px] text-on-surface-variant/40 truncate">
                              {shared?.name ?? shortenAddress(o.relayer)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
