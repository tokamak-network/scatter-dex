"use client";

import { formatGasEth, type GasEstimate } from "../lib/gasEstimate";

interface FeeBreakdownProps {
  gasEstimate: GasEstimate;
  baseFeeBps: number;
  minFeeBps: number;
  effectiveFeeBps: number;
  claimCount: number;
}

export default function FeeBreakdown({ gasEstimate, baseFeeBps, minFeeBps, effectiveFeeBps, claimCount }: FeeBreakdownProps) {
  return (
    <div className="bg-surface-container-low rounded-md p-3 space-y-1 text-[10px] text-on-surface-variant border border-outline-variant/10">
      <div className="font-bold text-on-surface mb-1">Fee Breakdown</div>
      <div className="flex justify-between">
        <span>Base relay fee</span>
        <span className="font-mono">{(baseFeeBps / 100).toFixed(2)}% ({baseFeeBps} bps)</span>
      </div>
      <div className="flex justify-between">
        <span>Gas coverage</span>
        <span className="font-mono">{minFeeBps > 0 ? `${(minFeeBps / 100).toFixed(2)}%` : "—"} ({minFeeBps} bps)</span>
      </div>
      <div className="pl-2 space-y-0.5 text-on-surface-variant/70">
        <div className="flex justify-between">
          <span>├ Settle tx</span>
          <span className="font-mono">~{formatGasEth(gasEstimate.settleGasWei)} ETH</span>
        </div>
        <div className="flex justify-between">
          <span>└ {claimCount} claim{claimCount > 1 ? "s" : ""}</span>
          <span className="font-mono">~{formatGasEth(gasEstimate.claimGasWei * BigInt(claimCount))} ETH</span>
        </div>
      </div>
      <div className="flex justify-between pt-1 border-t border-outline-variant/10">
        <span>Total gas</span>
        <span className="font-mono">~{formatGasEth(gasEstimate.totalGasWei)} ETH</span>
      </div>
      <div className="flex justify-between font-bold text-on-surface pt-1 border-t border-outline-variant/10">
        <span>Effective fee</span>
        <span className="font-mono">{(effectiveFeeBps / 100).toFixed(2)}% ({effectiveFeeBps} bps)</span>
      </div>
    </div>
  );
}
