/** Render a fixed-point token amount without pulling in `ethers`
 *  on the app side (operators app doesn't list it as a direct dep
 *  — the SDK does). */
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

/** Render a wei bigint as ETH with up to 18 decimal precision and
 *  trailing-zero trimming — same shape `OperatorRow.bondEth` uses,
 *  but on the app side so list views can format raw `RelayerOnChain.bond`. */
export function formatEther(wei: bigint): string {
  return formatTokenAmount(wei, 18);
}

/** Render a unix-seconds timestamp as a locale-stable `YYYY-MM-DD`.
 *  `toLocaleDateString` would disagree between server and client and
 *  trip Next's hydration mismatch warning, so we keep the ISO slice
 *  for any markup that's prerendered. */
export function formatIsoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
