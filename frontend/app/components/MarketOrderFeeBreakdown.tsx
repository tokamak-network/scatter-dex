"use client";

import { ethers } from "ethers";
import { Coins } from "lucide-react";

export interface MarketOrderFeeBreakdownProps {
  buyToken: { symbol: string; decimals: number };
  buyAmount: string;              // totalLocked (user's floor)
  estimatedOutput?: string;       // Quoter-reported gross at submission
  slippageBps?: number;
  dexSource?: string;
  /** Visual variant — "card" for popup detail, "inline" for embedded section. */
  variant?: "card" | "inline";
}

/**
 * Shared fee-breakdown for DEX Trade (market orders). Max Fee on market path
 * is always 0 — the real economic cost is the positive-slippage surplus
 * flowing to FeeVault.platformRevenue, bounded by (estimatedOutput − buyAmount).
 */
export default function MarketOrderFeeBreakdown({
  buyToken,
  buyAmount,
  estimatedOutput,
  slippageBps,
  dexSource,
  variant = "card",
}: MarketOrderFeeBreakdownProps) {
  const totalLocked = safeBigInt(buyAmount);
  const estimated = safeBigInt(estimatedOutput ?? "0");
  const surplusMax = estimated > totalLocked ? estimated - totalLocked : 0n;
  const fmt = (v: bigint) => ethers.formatUnits(v, buyToken.decimals);

  const rounded = variant === "card" ? "rounded-lg" : "rounded-md";

  return (
    <div className={`bg-warning/10 border border-warning/20 ${rounded} px-4 py-3 space-y-1.5 text-xs`}>
      <div className="flex items-center gap-1.5 text-warning font-bold uppercase tracking-wider">
        <Coins className="w-3.5 h-3.5" />
        DEX Trade Fees
      </div>
      <Row label="Platform fee (upfront)" value={<span className="font-mono text-on-surface-variant">0.00% / 0 {buyToken.symbol}</span>} />
      <Row label="Slippage tolerance" value={<span className="font-mono text-on-surface">{slippageBps != null ? `${(slippageBps / 100).toFixed(2)}%` : "—"}</span>} />
      <Row label="Est. output at submission" value={<span className="font-mono text-on-surface">{estimated > 0n ? `${fmt(estimated)} ${buyToken.symbol}` : "—"}</span>} />
      <Row label="Min receive (you get)" value={<span className="font-mono text-tertiary">{fmt(totalLocked)} {buyToken.symbol}</span>} />
      <div className="flex justify-between pt-1 border-t border-warning/20">
        <span className="text-on-surface-variant/70">Surplus → FeeVault (max)</span>
        <span className="font-mono text-warning">≤ {fmt(surplusMax)} {buyToken.symbol}</span>
      </div>
      {dexSource && (
        <Row label="Route" value={<span className="font-mono text-on-surface-variant">{dexSource}</span>} />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-on-surface-variant/70">{label}</span>
      {value}
    </div>
  );
}

function safeBigInt(v: string): bigint {
  try { return BigInt(v); } catch { return 0n; }
}
