/** Build an explorer URL from an env-sourced base + a `tx` / `address`
 *  / `block` segment. Returns `null` whenever the base is missing,
 *  doesn't parse, uses a non-http(s) protocol (rejecting
 *  `javascript:` / `data:` injected via a misconfigured env), or the
 *  value is empty.
 *
 *  Pure function so it lives in the SDK util tier — every app
 *  (Pay, Pro, Operators, Frontend, Hub) needs the same protocol
 *  allowlist + URL constructor pattern, and three independent bot
 *  reviews flagged the same gap on PRs that shipped inline copies.
 *  Centralising here also handles bases that include a sub-path
 *  (e.g. `https://explorer.io/eth-mainnet/`) — `url.pathname`
 *  composition preserves the prefix, where naive string concat
 *  would over- or under-slash it. */
export type ExplorerSegment = "tx" | "address" | "block";

export function buildExplorerUrl(
  base: string | undefined | null,
  segment: ExplorerSegment,
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
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${segment}/${encodeURIComponent(value)}`;
  return url.toString();
}

/** Convenience wrapper for the most common case (tx hash). */
export function buildExplorerTxUrl(
  base: string | undefined | null,
  txHash: string,
): string | null {
  return buildExplorerUrl(base, "tx", txHash);
}

/** Convenience wrapper for address links. */
export function buildExplorerAddressUrl(
  base: string | undefined | null,
  address: string,
): string | null {
  return buildExplorerUrl(base, "address", address);
}
