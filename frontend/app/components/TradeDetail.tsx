"use client";

import { ethers } from "ethers";
import { ArrowRight, Clock, Shield, Coins, CheckCircle2 } from "lucide-react";
import { getTokenList, type TokenInfo } from "../lib/tokens";
import { toAddressHex } from "../lib/zk/commitment";
import { useClaimStatuses } from "../lib/zk/useClaimStatuses";

export interface TradeOrder {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: number;
  expiry: string;
  nonce: string;
  leafIndex: number;
}

export interface TradeClaim {
  secret?: string;
  recipient: string;
  token: string;
  amount: string;
  releaseTime: string;
  leafIndex?: number;
}

export interface TradeChange {
  amount: string;
  salt: string;
  expectedCommitment: string;
}

export interface TradeData {
  order: TradeOrder;
  change: TradeChange | null;
  claims: TradeClaim[];
  createdAt: string;
  status?: string;
  settleTxHash?: string;
  crossRelayer?: boolean;
}

function resolveToken(address: string, tokens: TokenInfo[]): { symbol: string; decimals: number } {
  try {
    const hex = address.startsWith("0x") ? address : "0x" + BigInt(address).toString(16).padStart(40, "0");
    const t = tokens.find((tk) => tk.address.toLowerCase() === hex.toLowerCase());
    return t ? { symbol: t.symbol, decimals: t.decimals } : { symbol: hex.slice(0, 10) + "...", decimals: 18 };
  } catch {
    return { symbol: address.slice(0, 10) + "...", decimals: 18 };
  }
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  matched: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  settled: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  cancelled: "bg-red-500/15 text-red-400/80 border-red-500/20",
  expired: "bg-surface-container text-on-surface-variant/50 border-outline-variant/10",
};

export function TradeDetail({ trade, compact }: { trade: TradeData; compact?: boolean }) {
  const tokens = getTokenList();
  const sell = resolveToken(trade.order.sellToken, tokens);
  const buy = resolveToken(trade.order.buyToken, tokens);

  // Same-token (scatter) trades are value-preserving: `buyAmount` in the
  // stored order is the post-fee distributable, so showing Sell → Buy as
  // "1.0000 → 0.9970" reads like a price drop. For the header display,
  // surface the gross amount on both sides and let the Fee + Recipients
  // rows account for where the difference goes.
  const isSameToken = (() => {
    try { return BigInt(trade.order.sellToken) === BigInt(trade.order.buyToken); }
    catch { return trade.order.sellToken.toLowerCase() === trade.order.buyToken.toLowerCase(); }
  })();
  const headerBuyAmount = isSameToken ? trade.order.sellAmount : trade.order.buyAmount;

  const claimStatuses = useClaimStatuses(compact ? [] : trade.claims);

  if (compact) {
    return (
      <div className="bg-surface-container rounded-lg px-4 py-3 flex items-center justify-between hover:bg-surface-bright/20 transition-colors cursor-pointer">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-error">
            {parseFloat(ethers.formatUnits(trade.order.sellAmount, sell.decimals)).toFixed(2)}
          </span>
          <span className="text-xs text-on-surface-variant/60">{sell.symbol}</span>
          <ArrowRight className="w-3.5 h-3.5 text-on-surface-variant/30" />
          <span className="font-mono text-sm font-semibold text-tertiary">
            {parseFloat(ethers.formatUnits(isSameToken ? trade.order.sellAmount : trade.order.buyAmount, buy.decimals)).toFixed(2)}
          </span>
          <span className="text-xs text-on-surface-variant/60">{buy.symbol}</span>
        </div>
        <div className="flex items-center gap-2">
          {trade.status && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${STATUS_STYLES[trade.status] ?? STATUS_STYLES.expired}`}>
              {trade.status}
            </span>
          )}
          <span className="text-[11px] text-on-surface-variant/40">
            {new Date(trade.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header: amounts */}
      <div className="flex items-center justify-center gap-4 py-3">
        <div className="text-center">
          <div className="text-2xl font-mono font-bold text-error">
            {parseFloat(ethers.formatUnits(trade.order.sellAmount, sell.decimals)).toFixed(4)}
          </div>
          <div className="text-xs text-on-surface-variant/60 mt-0.5">{sell.symbol}</div>
        </div>
        <ArrowRight className="w-6 h-6 text-on-surface-variant/30" />
        <div className="text-center">
          <div className="text-2xl font-mono font-bold text-tertiary">
            {parseFloat(ethers.formatUnits(headerBuyAmount, buy.decimals)).toFixed(4)}
          </div>
          <div className="text-xs text-on-surface-variant/60 mt-0.5">{buy.symbol}</div>
        </div>
      </div>

      {/* Status badge */}
      {trade.status && (
        <div className="flex justify-center">
          <span className={`text-xs px-3 py-1 rounded-full font-semibold border ${STATUS_STYLES[trade.status] ?? STATUS_STYLES.expired}`}>
            {trade.status.toUpperCase()}
          </span>
        </div>
      )}

      {/* Order info grid */}
      <div className="grid grid-cols-3 gap-3 bg-surface-container/50 rounded-lg px-4 py-3">
        <div className="text-center">
          <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Fee</div>
          <div className="text-sm font-mono mt-1">{(trade.order.maxFee / 100).toFixed(2)}%</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Expiry</div>
          <div className="text-sm font-mono mt-1">{new Date(Number(trade.order.expiry) * 1000).toLocaleDateString()}</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Leaf</div>
          <div className="text-sm font-mono mt-1">#{trade.order.leafIndex}</div>
        </div>
      </div>

      {/* Change */}
      {trade.change && (
        <div className="bg-amber-500/5 border border-amber-500/15 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <Coins className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Change</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-sm text-on-surface-variant/60">Remainder</span>
            <span className="text-lg font-mono font-bold text-amber-400">
              {parseFloat(ethers.formatUnits(trade.change.amount, sell.decimals)).toFixed(4)} {sell.symbol}
            </span>
          </div>
        </div>
      )}

      {/* Claims */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Shield className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-semibold text-on-surface uppercase tracking-wider">
            Recipients ({trade.claims.length})
          </span>
        </div>
        <div className="space-y-2">
          {trade.claims.map((c, i) => {
            const ct = resolveToken(c.token, tokens);
            const addr = toAddressHex(c.recipient);
            const isClaimed = claimStatuses[i]?.claimed === true;
            return (
              <div key={i} className={`rounded-lg px-4 py-3 space-y-1.5 ${isClaimed ? "bg-emerald-500/5 border border-emerald-500/15" : "bg-surface-container"}`}>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-on-surface-variant/50">#{i + 1}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-mono font-bold text-on-surface">
                      {parseFloat(ethers.formatUnits(c.amount, ct.decimals)).toFixed(4)} {ct.symbol}
                    </span>
                    {isClaimed && (
                      <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                        <CheckCircle2 className="w-3 h-3" /> Claimed
                      </span>
                    )}
                  </div>
                </div>
                <div className="font-mono text-[11px] text-on-surface-variant/40 break-all leading-relaxed">
                  {addr}
                </div>
                <div className="flex items-center gap-1 text-xs text-on-surface-variant/50">
                  <Clock className="w-3 h-3" />
                  {new Date(Number(c.releaseTime) * 1000).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Settle tx */}
      {trade.settleTxHash && (
        <div className="bg-surface-container/50 rounded-lg px-4 py-2 text-xs space-y-1">
          <div>
            <span className="text-on-surface-variant/40">Settlement Tx: </span>
            <span className="font-mono text-primary break-all">{trade.settleTxHash}</span>
          </div>
          {trade.crossRelayer && (
            <div className="flex items-center gap-1.5">
              <span className="inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/15 text-purple-400 border border-purple-500/20">
                Cross-Relayer
              </span>
              <span className="text-on-surface-variant/40">Matched across relayers</span>
            </div>
          )}
        </div>
      )}

      {/* Created at */}
      <div className="text-center text-[11px] text-on-surface-variant/30">
        Created {new Date(trade.createdAt).toLocaleString()}
      </div>
    </div>
  );
}
