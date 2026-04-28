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
