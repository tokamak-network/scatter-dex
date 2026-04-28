/** Render a fixed-point token amount as a decimal string without
 *  pulling `ethers` into the consumer (the SDK already lists it,
 *  apps don't have to). Trims trailing zeros from the fractional
 *  part — `1.5`, not `1.500000`. Negative inputs render with a
 *  leading minus. `decimals === 0` short-circuits to the integer.
 *  Shared by every list view that surfaces raw `bigint` balances
 *  (operators treasury / leaderboard, pro orders, …). */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Render a wei bigint as ETH — same shape `OperatorRow.bondEth`
 *  uses internally, but exposed for callers that hold a raw
 *  `RelayerOnChain.bond` / `FeeVault.balances` value and want to
 *  display it without their own ethers dependency. */
export function formatEther(wei: bigint): string {
  return formatTokenAmount(wei, 18);
}
