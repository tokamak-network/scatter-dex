/**
 * Relayer-fee math. Mirrors `FEE_BPS_DENOMINATOR` in
 * `contracts/src/zk/SettleVerifyLib.sol` (10_000) and the same
 * helper in `frontend/app/lib/fee.ts`. Used to bridge the
 * `relayer.fee` bps reading from the registry into the
 * "you receive (net) = buyAmount − fee" math the order form needs
 * before signing.
 */

export const FEE_BPS_DENOMINATOR = 10_000;
export const FEE_BPS_DENOMINATOR_BIG = 10_000n;

/** BigInt `gross × bps / 10000` with saturating subtract for `net`. */
export function applyFeeBig(gross: bigint, bps: number): { fee: bigint; net: bigint } {
  const fee = (gross * BigInt(bps)) / FEE_BPS_DENOMINATOR_BIG;
  return { fee, net: gross > fee ? gross - fee : 0n };
}

/** Float version for display. Matches the BigInt result to ≤1 wei. */
export function applyFee(gross: number, bps: number): { fee: number; net: number } {
  const fee = (gross * bps) / FEE_BPS_DENOMINATOR;
  return { fee, net: gross - fee };
}
