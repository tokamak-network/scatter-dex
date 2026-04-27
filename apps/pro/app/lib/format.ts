/** Display helpers shared across the Pro app. Centralised here so
 *  /orders, the order detail drawer, and the order modal render
 *  numeric / time fields the same way. */

/** Format a bigint token amount with the token's decimal precision.
 *  Trims trailing zeros from the fractional part (`1.5`, not
 *  `1.500000`). Returns the raw integer when `decimals <= 0`. */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
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
 *  (`"1,234.56"` → `1234.56`). Returns `NaN` when input is empty
 *  or otherwise unparseable; callers should `Number.isFinite()`
 *  the result. Assumes en-US convention (dot as decimal separator)
 *  — matches every numeric input in the app. */
export function parseLooseNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}
