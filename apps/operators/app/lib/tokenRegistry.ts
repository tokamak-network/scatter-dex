/**
 * NEXT_PUBLIC_TOKENS-derived symbol + decimals lookup, shared by any
 * operators page that renders ERC-20 amounts (analytics, shared
 * orders, etc.). Lifting it out of /analytics avoids two pages drifting
 * on parser quirks (trimming, malformed entries, etc.) when a third
 * consumer lands.
 *
 * Env format: comma-separated `address:symbol:decimals` triples, with
 * whitespace around commas and colons tolerated.
 */

import { shortAddr } from "@zkscatter/sdk/react";
import { formatTokenAmount } from "@zkscatter/sdk/util";

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

// Module-level — env is static for the page's lifetime, so re-parsing
// on every call would just burn CPU for the same result.
const TOKEN_REGISTRY: Map<string, TokenInfo> = (() => {
  const raw = process.env.NEXT_PUBLIC_TOKENS ?? "";
  const map = new Map<string, TokenInfo>();
  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const [addr, symbol, decStr] = entry.split(":").map((s) => s.trim());
    if (!addr || !symbol) continue;
    map.set(addr.toLowerCase(), { symbol, decimals: Number(decStr) || 0 });
  }
  return map;
})();

/** Look up token metadata by address; falls back to the shortened
 *  address as the "symbol" and 0 decimals (raw wei) when the env
 *  registry doesn't know the token. Callers shouldn't have to branch
 *  on null. */
export function tokenInfo(addr: string | null | undefined): TokenInfo {
  if (!addr) return { symbol: "—", decimals: 0 };
  return (
    TOKEN_REGISTRY.get(addr.toLowerCase()) ?? { symbol: shortAddr(addr), decimals: 0 }
  );
}

/** Format a wei string using the given decimals, falling through to
 *  the raw string when BigInt parsing fails (so a malformed payload
 *  doesn't blank the cell — the operator still sees what arrived).
 *  `wei` is permissive: `"0"` and empty string both render as `"0"`. */
export function formatAmount(wei: string | null | undefined, decimals: number): string {
  if (!wei || wei === "0") return "0";
  try {
    return formatTokenAmount(BigInt(wei), decimals);
  } catch {
    return wei;
  }
}
