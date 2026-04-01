"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { Radio, ExternalLink, Loader2, AlertCircle, RefreshCw, Circle, Globe, Activity, BarChart3 } from "lucide-react";
import { useRelayers, type RelayerInfo, type RelayerOrderbook } from "../../lib/useRelayers";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import { SETTLEMENT_ABI } from "../../lib/contracts";
import { getSettlementAddress, RPC_URL } from "../../lib/config";
import { shortenAddress } from "../../lib/utils";

const provider = new ethers.JsonRpcProvider(RPC_URL);

function formatBond(bond: bigint): string {
  const val = Number(ethers.formatEther(bond));
  return val % 1 === 0 ? `${val} ETH` : `${val.toFixed(2)} ETH`;
}

function feeBps(fee: number): string {
  return `${(fee / 100).toFixed(2)}%`;
}

function timeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

// ─── Helpers ─────────────────────────────────────────────────
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

  // price = quote (tB) per base (tA)
  const calcPrice = (baseAmt: string, quoteAmt: string, baseDec: number, quoteDec: number) => {
    const base = Number(ethers.formatUnits(baseAmt, baseDec));
    const quote = Number(ethers.formatUnits(quoteAmt, quoteDec));
    return base > 0 ? formatPrice(quote / base) : "0";
  };

  const askMap = new Map<string, number>();
  const bidMap = new Map<string, number>();

  for (const ob of orderbooks) {
    // sells: maker sells tA to buy tB → price = buyAmount(tB) / sellAmount(tA)
    for (const o of ob.sells) {
      const price = calcPrice(o.sellAmount, o.buyAmount, dA, dB);
      const qty = Number(ethers.formatUnits(o.sellAmount, dA));
      askMap.set(price, (askMap.get(price) ?? 0) + qty);
    }
    // buys: maker sells tB to buy tA → price = sellAmount(tB) / buyAmount(tA)
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
    return <div className="text-xs text-on-surface-variant/30 text-center py-16">No orders in this pair</div>;
  }

  return (
    <div>
      {/* Column headers */}
      <div className="grid grid-cols-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider px-3 py-2">
        <span className="text-right">Qty ({symA})</span>
        <span className="text-center">Price ({symB})</span>
        <span className="text-left">Qty ({symB})</span>
      </div>

      <div className="max-h-[400px] overflow-y-auto">
        {/* Asks: reversed so highest is at top, lowest near spread */}
        {[...asks].reverse().map((a, i) => (
          <div key={`a-${i}`} className="grid grid-cols-3 items-center px-3 py-[5px] text-xs hover:bg-error/5 transition-colors">
            <div className="relative text-right pr-1">
              <div className="absolute right-0 top-0 bottom-0 bg-error/8 rounded-l" style={{ width: `${(a.qty / maxAskQty) * 100}%` }} />
              <span className="relative font-mono text-on-surface-variant/70">{a.qty.toFixed(4)}</span>
            </div>
            <span className="text-center font-mono text-error">{a.price}</span>
            <span />
          </div>
        ))}

        {/* Spread */}
        {asks.length > 0 && bids.length > 0 && (
          <div className="flex items-center justify-center py-2 border-y border-outline-variant/10 my-0.5">
            <span className="text-[10px] text-on-surface-variant/40">
              spread {(asks[0].priceNum - bids[0].priceNum).toFixed(2)} {symB}
            </span>
          </div>
        )}

        {/* Bids: highest first (near spread) */}
        {bids.map((b, i) => (
          <div key={`b-${i}`} className="grid grid-cols-3 items-center px-3 py-[5px] text-xs hover:bg-primary/5 transition-colors">
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

// ─── Recent Settlements ──────────────────────────────────────
interface SettleEvent {
  maker: string;
  taker: string;
  claimCount: number;
  blockNumber: number;
  txHash: string;
}

function RecentSettlements() {
  const [events, setEvents] = useState<SettleEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const settlement = new ethers.Contract(getSettlementAddress(), SETTLEMENT_ABI, provider);
        const filter = settlement.filters.Settled();
        const blockNumber = await provider.getBlockNumber();
        const fromBlock = Math.max(0, blockNumber - 5000);
        const logs = await settlement.queryFilter(filter, fromBlock, blockNumber);

        const parsed: SettleEvent[] = logs.slice(-10).reverse().map((log) => {
          const e = log as ethers.EventLog;
          return {
            maker: e.args[0] as string,
            taker: e.args[1] as string,
            claimCount: (e.args[2] as string[]).length,
            blockNumber: e.blockNumber,
            txHash: e.transactionHash,
          };
        });
        setEvents(parsed);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-4">
      <h3 className="text-xs font-semibold text-on-surface flex items-center gap-2 mb-3">
        <Activity className="w-3.5 h-3.5" /> Recent Settlements
      </h3>
      {loading ? (
        <div className="text-xs text-on-surface-variant/40 py-4 text-center">
          <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> Loading...
        </div>
      ) : events.length === 0 ? (
        <div className="text-xs text-on-surface-variant/30 py-4 text-center">No settlements yet</div>
      ) : (
        <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
          {events.map((e, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-bright/30 text-[11px] transition-colors">
              <div>
                <span className="font-mono text-on-surface-variant">{shortenAddress(e.maker)}</span>
                <span className="text-on-surface-variant/30 mx-1">&harr;</span>
                <span className="font-mono text-on-surface-variant">{shortenAddress(e.taker)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-on-surface-variant/40">{e.claimCount} claims</span>
                <span className="text-on-surface-variant/30">#{e.blockNumber}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Network Stats ───────────────────────────────────────────
function NetworkStats({ relayers }: { relayers: RelayerInfo[] }) {
  const online = relayers.filter((r) => r.online);
  const totalBond = relayers.reduce((s, r) => s + r.bond, BigInt(0));
  const totalOrders = online.reduce((s, r) => s + (r.api?.orderCount ?? 0), 0);
  const avgFee = relayers.length > 0
    ? (relayers.reduce((s, r) => s + r.fee, 0) / relayers.length).toFixed(0)
    : "0";

  const stats = [
    { label: "Relayers", value: `${online.length} / ${relayers.length}`, sub: "online / total" },
    { label: "Total Bond", value: formatBond(totalBond), sub: "staked" },
    { label: "Pending Orders", value: String(totalOrders), sub: "across network" },
    { label: "Avg Fee", value: `${(Number(avgFee) / 100).toFixed(2)}%`, sub: `${avgFee} bps` },
  ];

  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-4">
      <h3 className="text-xs font-semibold text-on-surface flex items-center gap-2 mb-3">
        <BarChart3 className="w-3.5 h-3.5" /> Network Stats
      </h3>
      <div className="grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface rounded-lg p-2.5">
            <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">{s.label}</div>
            <div className="text-sm font-semibold text-on-surface mt-0.5">{s.value}</div>
            <div className="text-[10px] text-on-surface-variant/30">{s.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────
export default function RelayersPage() {
  const { relayers, loading, error, refresh } = useRelayers();
  // null = "Network" (all), number = specific relayer index
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [activePairIdx, setActivePairIdx] = useState(0);
  const [orderbooks, setOrderbooks] = useState<Map<string, RelayerOrderbook>>(new Map());
  const [obLoading, setObLoading] = useState(false);

  const tokens = useMemo(() => getTokenList(), []);
  const pairOptions = useMemo(() => buildPairOptions(tokens), [tokens]);
  const selectedPair = pairOptions[activePairIdx]?.value ?? "";
  const findToken = (addr: string) => tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());

  const pts = selectedPair.split("-");
  const symA = findToken(pts[0])?.symbol ?? "?";
  const symB = findToken(pts[1])?.symbol ?? "?";

  const onlineRelayers = useMemo(() => relayers.filter((r) => r.online), [relayers]);
  const selected = useMemo(() => selectedIdx !== null ? relayers[selectedIdx] : null, [selectedIdx, relayers]);

  // Fetch orderbooks from all online relayers (or single selected)
  const loadOrderbooks = useCallback(async (pair: string) => {
    if (!pair) return;
    setObLoading(true);
    const targets = selected && selected.online ? [selected] : onlineRelayers;
    const results = new Map<string, RelayerOrderbook>();

    await Promise.allSettled(
      targets.map(async (r) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(`${r.url}/api/orderbook/${pair}`, { signal: controller.signal });
          if (res.ok) results.set(r.address, await res.json());
        } catch { /* skip failed */ } finally {
          clearTimeout(timeout);
        }
      })
    );

    setOrderbooks(results);
    setObLoading(false);
  }, [selected, onlineRelayers]);

  useEffect(() => {
    if (pairOptions.length > 0 && relayers.length > 0) {
      loadOrderbooks(pairOptions[activePairIdx]?.value ?? "");
    }
  }, [activePairIdx, relayers.length, loadOrderbooks, pairOptions]);

  const selectPair = (idx: number) => {
    setActivePairIdx(idx);
  };

  // Build aggregated or filtered orderbook
  const visibleOrderbooks = selected
    ? (orderbooks.has(selected.address) ? [orderbooks.get(selected.address)!] : [])
    : Array.from(orderbooks.values());

  const { asks, bids } = selectedPair
    ? aggregateOrderbook(visibleOrderbooks, tokens, selectedPair)
    : { asks: [], bids: [] };

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3">
            <Radio className="w-7 h-7 text-primary" />
            Relayers
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
        <>
          {/* ─── Relayer cards (horizontal) ─── */}
          <div className="flex gap-2 mb-5 overflow-x-auto pb-2">
            {/* Network (all) card */}
            <button
              onClick={() => setSelectedIdx(null)}
              className={`flex-shrink-0 rounded-lg border px-4 py-3 text-left transition-all min-w-[140px] ${
                selectedIdx === null
                  ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                  : "border-outline-variant/15 bg-surface-container hover:bg-surface-bright/30"
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <Globe className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-semibold text-on-surface">Network</span>
              </div>
              <div className="text-[10px] text-on-surface-variant/50 space-y-0.5">
                <div>{onlineRelayers.length} online</div>
                <div>{onlineRelayers.reduce((s, r) => s + (r.api?.orderCount ?? 0), 0)} orders</div>
              </div>
            </button>

            {relayers.map((r, i) => (
              <button
                key={r.address}
                onClick={() => setSelectedIdx(i)}
                className={`flex-shrink-0 rounded-lg border px-4 py-3 text-left transition-all min-w-[140px] ${
                  selectedIdx === i
                    ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                    : "border-outline-variant/15 bg-surface-container hover:bg-surface-bright/30"
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Circle className={`w-2.5 h-2.5 fill-current ${r.online ? "text-primary" : "text-error/40"}`} />
                  <span className="text-xs font-mono text-on-surface">{shortenAddress(r.address)}</span>
                </div>
                <div className="text-[10px] text-on-surface-variant/50 space-y-0.5">
                  <div className="flex gap-3">
                    <span>Fee {feeBps(r.fee)}</span>
                    <span>{formatBond(r.bond)}</span>
                  </div>
                  <div>{r.api?.orderCount ?? 0} orders &middot; {timeAgo(r.registeredAt)}</div>
                </div>
              </button>
            ))}
          </div>

          {/* ─── Selected relayer detail bar ─── */}
          {selected && (
            <div className="flex items-center gap-4 mb-4 px-4 py-2.5 bg-surface-container rounded-lg border border-outline-variant/10 text-xs">
              <Circle className={`w-2.5 h-2.5 fill-current flex-shrink-0 ${selected.online ? "text-primary" : "text-error/40"}`} />
              <span className="font-mono text-on-surface">{selected.address}</span>
              <a href={`${selected.url}/api/info`} target="_blank" rel="noreferrer"
                className="text-primary hover:underline flex items-center gap-1">
                {selected.url} <ExternalLink className="w-3 h-3" />
              </a>
              {selected.api && (
                <span className="text-on-surface-variant/50 ml-auto">
                  {selected.api.name} v{selected.api.version}
                </span>
              )}
            </div>
          )}

          {/* ─── Main content: Orderbook (left) + Side panels (right) ─── */}
          <div className="flex gap-4">
            {/* Left: Pair tabs + Orderbook */}
            <div className="flex-1 bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
              {/* Pair tabs */}
              {pairOptions.length > 0 && (
                <div className="flex border-b border-outline-variant/10">
                  {pairOptions.map((p, i) => (
                    <button
                      key={p.value}
                      onClick={() => selectPair(i)}
                      className={`px-5 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                        activePairIdx === i
                          ? "border-primary text-primary bg-surface-bright/20"
                          : "border-transparent text-on-surface-variant/50 hover:text-on-surface"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                  {obLoading && <Loader2 className="w-3 h-3 animate-spin text-on-surface-variant/30 self-center ml-auto mr-4" />}
                </div>
              )}

              {/* Orderbook */}
              <div className="max-w-[480px] mx-auto py-2">
                <OrderbookDisplay asks={asks} bids={bids} symA={symA} symB={symB} />
              </div>
            </div>

            {/* Right: Stats + Recent settlements */}
            <div className="w-[280px] flex-shrink-0 space-y-4">
              <NetworkStats relayers={relayers} />
              <RecentSettlements />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
