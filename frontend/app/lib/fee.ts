/**
 * Fee math shared between order-form UI, shared orderbook display, and
 * matcher/Solidity/circom layers. Mirrors `FEE_BPS_DENOMINATOR` in
 * `zk-relayer/src/core/matcher.ts` and `SettleVerifyLib.FEE_BPS_DENOMINATOR`.
 */

export const FEE_BPS_DENOMINATOR = 10_000;
export const FEE_BPS_DENOMINATOR_BIG = 10_000n;

/** BigInt "gross × fee / 10000" — saturating subtract for the net amount. */
export function applyFeeBig(gross: bigint, bps: number): { fee: bigint; net: bigint } {
  const fee = (gross * BigInt(bps)) / FEE_BPS_DENOMINATOR_BIG;
  return { fee, net: gross > fee ? gross - fee : 0n };
}

/** Float version for display. Matches the BigInt result to ≤1 wei. */
export function applyFee(gross: number, bps: number): { fee: number; net: number } {
  const fee = (gross * bps) / FEE_BPS_DENOMINATOR;
  return { fee, net: gross - fee };
}
