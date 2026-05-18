/** Display helpers shared across the Pro app. Centralised here so
 *  /orders, the order detail drawer, and the order modal render
 *  numeric / time fields the same way. The bigint-only token
 *  amount helper is shared with operators via the SDK. */

import { formatTokenAmount } from "@zkscatter/sdk/util";
export { formatTokenAmount };

/** Fallback to raw bigint + `(raw units)` suffix keeps a
 *  misconfigured deployment visibly debuggable instead of silently
 *  formatting zero. */
export function formatClaimAmount(
  amount: bigint,
  tokenAddress: string,
  tokens: readonly { address: string; decimals: number; symbol: string }[],
): string {
  const tok = tokens.find(
    (t) => t.address.toLowerCase() === tokenAddress.toLowerCase(),
  );
  if (tok) return `${formatTokenAmount(amount, tok.decimals)} ${tok.symbol}`;
  return `${amount.toString()} (raw units)`;
}

/** Human-readable UTC timestamp (`Apr 26, 09:14 UTC`). Locale fixed
 *  to `en-US` so SSR and client agree. */
export function formatWhen(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC"
  );
}

/** Pad a hex bigint string to 64 chars (32 bytes) with the `0x`
 *  prefix. Useful for displaying nonces / secrets / commitment
 *  values consistently — `toString(16)` alone trims leading zeros
 *  and produces variable-length output. */
export function formatField(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** USD value with 2-decimal precision and en-US locale grouping
 *  (`$1,234.50`). Returns `—` when the input isn't a finite number
 *  so callers can pass `null` / `NaN` straight through without a
 *  guard. */
export function formatUsd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

/** Parse a display number that may carry comma thousands separators
 *  (`"1,234.56"` → `1234.56`). Returns `NaN` when input is empty,
 *  whitespace-only, or otherwise unparseable — callers should
 *  `Number.isFinite()` the result before using it. Assumes en-US
 *  convention (dot as decimal separator). */
export function parseLooseNumber(s: string): number {
  const trimmed = s.trim();
  if (trimmed === "") return NaN;
  return Number(trimmed.replace(/,/g, ""));
}
