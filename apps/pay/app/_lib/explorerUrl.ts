/** Build an explorer transaction URL from a base + tx hash. Returns
 *  `null` when:
 *    - the explorer isn't configured (no base set),
 *    - the base doesn't parse as a URL,
 *    - the base's protocol isn't `http:` / `https:` (e.g. `javascript:`
 *      / `data:` pulled in via a misconfigured env), or
 *    - the tx hash is empty.
 *
 *  Callers can branch on a falsy value without a separate "is
 *  explorer safe" predicate. Built on `new URL(base)` so trailing
 *  slashes and overlapping `pathname` segments are handled by the
 *  URL spec rather than ad-hoc string concat — matches the URL-
 *  construction pattern the operators app and the claim flow
 *  already use.
 */
export function buildExplorerTxUrl(
  base: string | undefined,
  txHash: string,
): string | null {
  return buildExplorerPathUrl(base, "tx", txHash);
}

/** Build an explorer address URL. Same safety contract as
 *  `buildExplorerTxUrl`. Used by the address cell in payouts/detail
 *  and any future surface that links wallet addresses to the chain. */
export function buildExplorerAddressUrl(
  base: string | undefined,
  address: string,
): string | null {
  return buildExplorerPathUrl(base, "address", address);
}

/** Shared core for the tx / address variants — kept private so the
 *  exported helpers stay parameter-typed (no chance of a caller
 *  passing the wrong segment kind by mistake). */
function buildExplorerPathUrl(
  base: string | undefined,
  segment: "tx" | "address",
  value: string,
): string | null {
  if (!base || !value) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Compose pathname against the existing base — preserves any
  // subpath the operator put in `explorerBase` (e.g. an Etherscan
  // proxy under `/eth-mainnet/`). Normalise the trailing slash so
  // joining doesn't produce `…//tx/…`.
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${segment}/${encodeURIComponent(value)}`;
  return url.toString();
}
