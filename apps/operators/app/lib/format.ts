// Re-export the shared formatters from the SDK so existing
// imports across the operators app keep working without each
// page touching the SDK barrel directly.
export { formatTokenAmount, formatEther } from "@zkscatter/sdk/util";

/** Render a unix-seconds timestamp as a locale-stable `YYYY-MM-DD`.
 *  `toLocaleDateString` would disagree between server and client and
 *  trip Next's hydration mismatch warning, so we keep the ISO slice
 *  for any markup that's prerendered. App-local for now — pro app
 *  uses a richer "Apr 26, 09:14 UTC" format, so a single shared
 *  date helper would force one team to compromise. */
export function formatIsoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Render an absolute unix-ms timestamp as a coarse "Xs/m/h/d ago"
 *  string. Floor-rounded buckets — fine for indicator text where
 *  the precise second isn't important. Negative diffs (clock skew
 *  or future-dated rows) clamp to "0s ago". */
export function formatRelative(unixMs: number): string {
  const diff = Math.max(0, Date.now() - unixMs);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
