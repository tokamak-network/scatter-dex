/** Build an explorer transaction URL from a base URL + tx hash.
 *  Returns `null` when the explorer isn't configured (no base set)
 *  so callers can branch on a falsy value without a separate "is
 *  explorer configured" predicate.
 *
 *  Trailing slashes on the base are tolerated and stripped so the
 *  output never looks like `https://etherscan.io//tx/0x…` after a
 *  copy-paste from an env file. */
export function buildExplorerTxUrl(
  base: string | undefined,
  txHash: string,
): string | null {
  if (!base || !txHash) return null;
  return `${base.replace(/\/$/, "")}/tx/${txHash}`;
}

/** Build an explorer address URL. Same trailing-slash tolerance as
 *  `buildExplorerTxUrl`. Used by the address cell in payouts/detail
 *  and any future surface that links wallet addresses to the chain. */
export function buildExplorerAddressUrl(
  base: string | undefined,
  address: string,
): string | null {
  if (!base || !address) return null;
  return `${base.replace(/\/$/, "")}/address/${address}`;
}
