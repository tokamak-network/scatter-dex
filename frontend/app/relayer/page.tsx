"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { Radio, ExternalLink, Loader2, AlertCircle, RefreshCw, Circle, Globe, BarChart3, Vault, ArrowDownToLine, User } from "lucide-react";
import Link from "next/link";
import { useRelayers, type RelayerInfo, type RelayerOrderbook } from "../lib/useRelayers";
import { useWallet } from "../lib/wallet";
import { getTokenList, type TokenInfo } from "../lib/tokens";
import { getFeeVaultAddress } from "../lib/config";
import { FEE_VAULT_ABI } from "../lib/contracts";
import { getReadProvider } from "../lib/provider";
import { shortenAddress, formatBond, timeAgo } from "../lib/utils";
import { extractMessage } from "../lib/error-messages";
import SharedOrderbookStatus from "../components/SharedOrderbookStatus";
import { getOrders, type SharedRelayer, type SharedOrder } from "../lib/sharedOrderbook";

function feeBps(fee: number): string {
  return `${(fee / 100).toFixed(2)}%`;
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
  const { account, signer } = useWallet();
  const relayers = useMemo(() => allRelayers.filter((r) => r.api?.name?.includes("ZK") || !r.online), [allRelayers]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
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

  // FeeVault state
  const [vaultBalances, setVaultBalances] = useState<{ token: string; symbol: string; balance: bigint }[]>([]);
  const [vaultPlatformFee, setVaultPlatformFee] = useState<number>(0);
  const [claimingToken, setClaimingToken] = useState<string | null>(null);
  const [claimTxHash, setClaimTxHash] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const tokens = useMemo(() => getTokenList(), []);
  const pairOptions = useMemo(() => buildPairOptions(tokens), [tokens]);
  const findToken = (addr: string) => tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());

  const onlineRelayers = useMemo(() => relayers.filter((r) => r.online), [relayers]);
  const selected = useMemo(() => selectedIdx !== null ? relayers[selectedIdx] : null, [selectedIdx, relayers]);

  // Fetch all pair orderbooks for the selected relayer (or all online relayers for Network view)
  const loadOrderbooks = useCallback(async (target: RelayerInfo | null) => {
    const targets = target && target.online ? [target] : onlineRelayers;
    if (targets.length === 0 || pairOptions.length === 0) return;
    setObLoading(true);

    const results = new Map<string, Map<string, RelayerOrderbook>>();

    await Promise.allSettled(
      targets.map(async (r) => {
        const pairResults = new Map<string, RelayerOrderbook>();
        await Promise.allSettled(
          pairOptions.map(async (p) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
              const res = await fetch(`${r.url}/api/orderbook/${p.value}`, { signal: controller.signal });
              if (res.ok) pairResults.set(p.value, await res.json());
            } catch { /* skip */ } finally {
              clearTimeout(timeout);
            }
          })
        );
        results.set(r.address, pairResults);
      })
    );

    setOrderbooks(results);
    setObLoading(false);
  }, [onlineRelayers, pairOptions]);

  useEffect(() => {
    if (relayers.length > 0 && pairOptions.length > 0) {
      loadOrderbooks(selected);
    }
  }, [selected, relayers.length, pairOptions.length, loadOrderbooks]);

  // Load vault balances for connected account
  const feeVaultAddr = getFeeVaultAddress();
  const loadVaultBalances = useCallback(async () => {
    if (!account || !feeVaultAddr) { setVaultBalances([]); return; }
    try {
      const provider = getReadProvider();
      const vault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
      const feeBps = await vault.platformFeeBps();
      setVaultPlatformFee(Number(feeBps));

      const erc20Tokens = tokens.filter((t) => !t.isNative);
      const bals = await Promise.all(
        erc20Tokens.map(async (t) => {
          const bal = await vault.balances(account, t.address);
          return { token: t.address, symbol: t.symbol, balance: bal };
        })
      );
      setVaultBalances(bals.filter((b) => b.balance > 0n));
    } catch (e) {
      console.warn("Failed to load vault balances:", e);
    }
  }, [account, feeVaultAddr, tokens]);

  useEffect(() => { loadVaultBalances(); }, [loadVaultBalances]);

  const handleVaultClaim = useCallback(async (token: string) => {
    if (!signer || !feeVaultAddr) return;
    setClaimingToken(token);
    setClaimTxHash(null);
    setClaimError(null);
    try {
      const vault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, signer);
      const tx = await vault.claim(token);
      const receipt = await tx.wait();
      setClaimTxHash(receipt.hash ?? receipt.transactionHash);
      await loadVaultBalances();
    } catch (e: unknown) {
      console.error("Vault claim failed:", e);
      setClaimError(extractMessage(e));
    } finally {
      setClaimingToken(null);
    }
  }, [signer, feeVaultAddr, loadVaultBalances]);

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
        <div className="flex gap-5">
          {/* ─── Left: Relayer List ─── */}
          <div className="w-[320px] flex-shrink-0 space-y-2">
            {/* Network card */}
            <button
              onClick={() => setSelectedIdx(null)}
              className={`w-full rounded-xl border px-5 py-4 text-left transition-all ${
                selectedIdx === null
                  ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                  : "border-outline-variant/15 bg-surface-container hover:bg-surface-bright/30"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Globe className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-on-surface">All Network</span>
              </div>
              <div className="flex gap-4 text-[11px] text-on-surface-variant/60">
                <span>{onlineRelayers.length} online</span>
                <span>{onlineRelayers.reduce((s, r) => s + relayerOrderCount(r), 0)} orders</span>
                <span>{formatBond(relayers.reduce((s, r) => s + r.bond, 0n))} bonded</span>
              </div>
            </button>

            {/* Individual relayer cards */}
            {relayers.map((r, i) => (
              <div
                key={r.address}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedIdx(i)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedIdx(i); }}
                className={`w-full rounded-xl border px-5 py-4 text-left transition-all cursor-pointer ${
                  selectedIdx === i
                    ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                    : "border-outline-variant/15 bg-surface-container hover:bg-surface-bright/30"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Circle className={`w-2.5 h-2.5 fill-current ${r.online ? "text-primary" : "text-error/40"}`} />
                  <span className="text-sm font-mono text-on-surface">{shortenAddress(r.address)}</span>
                  {r.api?.name?.includes("ZK") && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-tertiary/20 text-tertiary font-bold">ZK</span>
                  )}
                  {!r.online && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-error/10 text-error/60 font-bold">offline</span>
                  )}
                </div>
                <div className="flex gap-4 text-[11px] text-on-surface-variant/60">
                  <span>Fee {feeBps(r.fee)}</span>
                  <span>{formatBond(r.bond)}</span>
                  <span>{relayerOrderCount(r)} orders</span>
                  <span>{timeAgo(r.registeredAt)}</span>
                </div>
                {r.online && r.url && (
                  <div className="text-[10px] text-on-surface-variant/40 font-mono mt-1 truncate">
                    {r.url}
                  </div>
                )}
                <Link
                  href={`/relayer/profile?address=${r.address}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 mt-2 text-[10px] text-primary hover:text-primary-container transition-colors"
                >
                  <User className="w-3 h-3" /> View Profile
                </Link>
                {(() => {
                  const shared = sharedRelayerMap.get(r.address.toLowerCase());
                  if (!shared) return null;
                  return (
                    <div className="mt-2 pt-2 border-t border-outline-variant/10 flex gap-3 text-[10px] text-on-surface-variant/50">
                      <span className="text-tertiary">Shared</span>
                      <span>{shared.orderCount} shared orders</span>
                      <span>Heartbeat: {timeAgo(shared.lastHeartbeat)}</span>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>

          {/* ─── Right: Selected Relayer Detail + Orderbooks per Pair ─── */}
          <div className="flex-1 space-y-4">
            {/* Detail bar */}
            {selected && (
              <div className="flex items-center gap-4 px-4 py-3 bg-surface-container rounded-xl border border-outline-variant/10 text-xs">
                <Circle className={`w-2.5 h-2.5 fill-current flex-shrink-0 ${selected.online ? "text-primary" : "text-error/40"}`} />
                <span className="font-mono text-on-surface">{selected.address}</span>
                <a href={`${selected.url}/api/info`} target="_blank" rel="noreferrer"
                  className="text-primary hover:underline flex items-center gap-1">
                  API <ExternalLink className="w-3 h-3" />
                </a>
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

            {/* FeeVault Section — visible when connected wallet has vault balance */}
            {feeVaultAddr && account && vaultBalances.length > 0 && (
              <div className="bg-surface-container rounded-xl border border-outline-variant/10 p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Vault className="w-4 h-4 text-tertiary" />
                    <span className="text-sm font-semibold text-on-surface">Fee Vault</span>
                    <span className="text-[10px] text-on-surface-variant/50">Platform fee: {(vaultPlatformFee / 100).toFixed(1)}%</span>
                  </div>
                  <button
                    onClick={loadVaultBalances}
                    className="text-[10px] text-primary hover:text-primary-container font-bold"
                  >
                    Refresh
                  </button>
                </div>

                <div className="space-y-2">
                    {vaultBalances.map((b) => {
                      const dec = findToken(b.token)?.decimals ?? 18;
                      const grossStr = ethers.formatUnits(b.balance, dec);
                      const netStr = ethers.formatUnits(b.balance * BigInt(10000 - vaultPlatformFee) / 10000n, dec);
                      // Truncate to min(dec, 6) decimal places without parseFloat precision loss
                      const maxDp = Math.min(dec, 6);
                      const truncate = (s: string) => { const [i, d] = s.split("."); return d ? `${i}.${d.slice(0, maxDp)}` : i; };
                      return (
                      <div key={b.token} className="flex items-center justify-between bg-surface rounded-lg px-4 py-3">
                        <div>
                          <span className="font-mono font-bold text-on-surface">
                            {truncate(grossStr)} {b.symbol}
                          </span>
                          <span className="text-[10px] text-on-surface-variant/40 ml-2">
                            (net: {truncate(netStr)})
                          </span>
                        </div>
                        <button
                          onClick={() => handleVaultClaim(b.token)}
                          disabled={claimingToken === b.token}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-tertiary/15 text-tertiary text-xs font-bold hover:bg-tertiary/25 transition-colors disabled:opacity-50"
                        >
                          {claimingToken === b.token ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <ArrowDownToLine className="w-3 h-3" />
                          )}
                          Claim
                        </button>
                      </div>
                      );
                    })}
                  </div>

                {claimTxHash && (
                  <div className="mt-2 text-[10px] font-mono text-primary bg-primary/5 rounded p-2 break-all">
                    Tx: {claimTxHash}
                  </div>
                )}
                {claimError && (
                  <div className="mt-2 text-[10px] text-error bg-error/5 rounded p-2">
                    {claimError}
                  </div>
                )}
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
