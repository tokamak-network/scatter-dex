"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { Radio, ExternalLink, Loader2, AlertCircle, RefreshCw, Circle, BookOpen } from "lucide-react";
import { useRelayers, fetchOrderbook, type RelayerInfo, type RelayerOrderbook } from "../../lib/useRelayers";
import { getTokenList, type TokenInfo } from "../../lib/tokens";

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatBond(bond: bigint): string {
  return `${ethers.formatEther(bond)} ETH`;
}

function feeBps(fee: number): string {
  return `${(fee / 100).toFixed(2)}%`;
}

function timeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function OrderbookPanel({ relayer }: { relayer: RelayerInfo }) {
  const [orderbook, setOrderbook] = useState<RelayerOrderbook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPair, setSelectedPair] = useState("");

  const tokens = getTokenList();
  const erc20Tokens = tokens.filter((t) => !t.isNative);

  // Build pair options from available tokens
  const pairOptions: { label: string; value: string }[] = [];
  for (let i = 0; i < erc20Tokens.length; i++) {
    for (let j = i + 1; j < erc20Tokens.length; j++) {
      const [a, b] = [erc20Tokens[i].address.toLowerCase(), erc20Tokens[j].address.toLowerCase()].sort();
      pairOptions.push({
        label: `${erc20Tokens[i].symbol}/${erc20Tokens[j].symbol}`,
        value: `${a}-${b}`,
      });
    }
  }

  const loadOrderbook = async (pair: string) => {
    setSelectedPair(pair);
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrderbook(relayer.url, pair);
      setOrderbook(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setOrderbook(null);
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (amount: string, token?: TokenInfo) => {
    const decimals = token?.decimals ?? 18;
    return Number(ethers.formatUnits(amount, decimals)).toFixed(4);
  };

  const findToken = (addr: string) => tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());

  return (
    <div className="mt-4 border-t border-outline-variant/15 pt-4">
      <div className="flex items-center gap-2 mb-3">
        <BookOpen className="w-4 h-4 text-on-surface-variant" />
        <span className="text-sm font-medium text-on-surface">Orderbook</span>
        {pairOptions.length > 0 && (
          <select
            value={selectedPair}
            onChange={(e) => loadOrderbook(e.target.value)}
            className="ml-auto text-xs bg-surface-container border border-outline-variant/30 rounded px-2 py-1 text-on-surface"
          >
            <option value="">Select pair</option>
            {pairOptions.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        )}
      </div>

      {loading && <div className="flex items-center gap-2 text-xs text-on-surface-variant"><Loader2 className="w-3 h-3 animate-spin" /> Loading...</div>}
      {error && <div className="text-xs text-error">{error}</div>}

      {orderbook && !loading && (
        <div className="grid grid-cols-2 gap-4 text-xs">
          {/* Sells */}
          <div>
            <div className="text-error/80 font-medium mb-1">Sells ({orderbook.sells.length})</div>
            {orderbook.sells.length === 0 ? (
              <div className="text-on-surface-variant/50">No sell orders</div>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {orderbook.sells.map((o, i) => {
                  const pairTokens = selectedPair.split("-");
                  const sellToken = findToken(pairTokens[0]) || findToken(pairTokens[1]);
                  return (
                    <div key={i} className="flex justify-between text-on-surface-variant">
                      <span>{shortenAddress(o.maker)}</span>
                      <span>{formatAmount(o.sellAmount, sellToken)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* Buys */}
          <div>
            <div className="text-primary/80 font-medium mb-1">Buys ({orderbook.buys.length})</div>
            {orderbook.buys.length === 0 ? (
              <div className="text-on-surface-variant/50">No buy orders</div>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {orderbook.buys.map((o, i) => {
                  const pairTokens = selectedPair.split("-");
                  const buyToken = findToken(pairTokens[1]) || findToken(pairTokens[0]);
                  return (
                    <div key={i} className="flex justify-between text-on-surface-variant">
                      <span>{shortenAddress(o.maker)}</span>
                      <span>{formatAmount(o.sellAmount, buyToken)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RelayerCard({ relayer, expanded, onToggle }: { relayer: RelayerInfo; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
      {/* Header */}
      <button onClick={onToggle} className="w-full px-6 py-4 flex items-center gap-4 hover:bg-surface-bright/30 transition-colors">
        {/* Status dot */}
        <Circle className={`w-3 h-3 fill-current ${relayer.online ? "text-primary" : "text-error/60"}`} />

        {/* Address + URL */}
        <div className="flex-1 text-left">
          <div className="font-mono text-sm text-on-surface">{shortenAddress(relayer.address)}</div>
          <div className="text-xs text-on-surface-variant/70 mt-0.5">{relayer.url}</div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-6 text-right">
          <div>
            <div className="text-xs text-on-surface-variant/60">Fee</div>
            <div className="text-sm font-medium text-on-surface">{feeBps(relayer.fee)}</div>
          </div>
          <div>
            <div className="text-xs text-on-surface-variant/60">Bond</div>
            <div className="text-sm font-medium text-on-surface">{formatBond(relayer.bond)}</div>
          </div>
          {relayer.api && (
            <div>
              <div className="text-xs text-on-surface-variant/60">Orders</div>
              <div className="text-sm font-medium text-on-surface">{relayer.api.orderCount}</div>
            </div>
          )}
          <div>
            <div className="text-xs text-on-surface-variant/60">Since</div>
            <div className="text-sm text-on-surface-variant">{timeAgo(relayer.registeredAt)}</div>
          </div>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-6 pb-4">
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs mb-3">
            <div className="flex justify-between">
              <span className="text-on-surface-variant/60">Full Address</span>
              <span className="font-mono text-on-surface">{relayer.address}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-variant/60">Status</span>
              <span className={relayer.online ? "text-primary" : "text-error"}>
                {relayer.online ? "Online" : "Offline"}
              </span>
            </div>
            {relayer.api && (
              <>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant/60">Name</span>
                  <span className="text-on-surface">{relayer.api.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant/60">Version</span>
                  <span className="text-on-surface">{relayer.api.version}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant/60">Settlement</span>
                  <span className="font-mono text-on-surface">{shortenAddress(relayer.api.settlement)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between">
              <span className="text-on-surface-variant/60">API</span>
              <a
                href={`${relayer.url}/api/info`}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline flex items-center gap-1"
              >
                {relayer.url} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>

          {relayer.online && <OrderbookPanel relayer={relayer} />}
        </div>
      )}
    </div>
  );
}

export default function RelayersPage() {
  const { relayers, loading, error, refresh } = useRelayers();
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3">
            <Radio className="w-7 h-7 text-primary" />
            Relayers
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            Registered relayers on the ScatterDEX network
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-container border border-outline-variant/30 text-sm text-on-surface hover:bg-surface-bright/50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-4 rounded-lg bg-error-container/10 border border-error/20 text-error text-sm mb-6">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && relayers.length === 0 && (
        <div className="flex items-center justify-center py-20 text-on-surface-variant">
          <Loader2 className="w-6 h-6 animate-spin mr-3" />
          Loading relayers from registry...
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && relayers.length === 0 && (
        <div className="text-center py-20 text-on-surface-variant/60">
          <Radio className="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p className="text-lg">No active relayers found</p>
          <p className="text-sm mt-1">Register a relayer on the RelayerRegistry contract to get started.</p>
        </div>
      )}

      {/* Relayer list */}
      <div className="space-y-3">
        {relayers.map((r, i) => (
          <RelayerCard
            key={r.address}
            relayer={r}
            expanded={expandedIdx === i}
            onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
          />
        ))}
      </div>

      {/* Summary */}
      {relayers.length > 0 && (
        <div className="mt-6 flex items-center gap-6 text-xs text-on-surface-variant/60">
          <span>{relayers.length} relayer{relayers.length !== 1 ? "s" : ""} registered</span>
          <span>{relayers.filter((r) => r.online).length} online</span>
          <span>Total bond: {formatBond(relayers.reduce((sum, r) => sum + r.bond, BigInt(0)))}</span>
        </div>
      )}
    </div>
  );
}
