export const FEE_BPS_DENOMINATOR = 10000n;

/**
 * Compute the fee one side pays in its own buyToken under the 2026-04-14
 * fee-semantics redesign (circuits/settle.circom:464–527). The caller's
 * relayer may undercut the user's signed `maxFee`; this picks the min.
 *
 *   fee = floor(buyAmount * min(relayerFeeBps, sideMaxFee) / 10000)
 *
 * Same-token scatter (scatterDirectAuth) uses a separate cap base
 * (sellAmount × maxFee) and should compute fee inline, not via this helper.
 */
export function computeSideFee(
  buyAmount: bigint | string,
  sideMaxFee: bigint | string,
  relayerFeeBps: bigint,
): bigint {
  const buy = typeof buyAmount === "bigint" ? buyAmount : BigInt(buyAmount);
  const maxFee = typeof sideMaxFee === "bigint" ? sideMaxFee : BigInt(sideMaxFee);
  const effectiveBps = relayerFeeBps < maxFee ? relayerFeeBps : maxFee;
  return (buy * effectiveBps) / FEE_BPS_DENOMINATOR;
}
