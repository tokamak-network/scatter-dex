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

/** Human-readable timestamp in the viewer's local timezone
 *  (`Apr 26, 06:14 PM KST`). Locale fixed to `en-US` so the
 *  month/day formatting stays predictable; the timezone
 *  follows the user. Previously hard-coded to UTC, which made
 *  the panel show times that looked like "in the past" to
 *  anyone east of GMT — the order *was* in the future once you
 *  did the offset math, but the UX failed the "no mental
 *  arithmetic" bar.
 *
 *  **SSR / hydration note.** This formatter is non-deterministic
 *  across pre-render → hydrate: the server runs in the build
 *  machine's timezone, the client in the viewer's. Both produce
 *  the same *instant*, just different surface text. Render call
 *  sites should either (a) put the output inside a node carrying
 *  `suppressHydrationWarning`, or (b) gate the formatting on a
 *  mounted state so the server emits a placeholder. The dollar
 *  cost is real but tiny (a brief flicker on first paint), the
 *  benefit is users seeing their own clock. */

/** Second-precision local timestamp ("2026-05-28 14:23:05"). Used on
 *  the `/claim` page where the recipient needs to know the exact
 *  unlock moment. Mirrors Pay's `formatLocalStampSec` so a claim
 *  package round-trips with identical copy across both apps. */
export function formatLocalStampSec(unixSec: number | undefined): string {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function formatWhen(ts: number): string {
  const d = new Date(ts);
  const base = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  // Append the locale's short timezone name (KST, EDT, …) when
  // the runtime exposes one. Older browsers without the
  // formatToParts → timeZoneName piece silently get the bare
  // time, which is still local — no false-UTC suffix.
  let tz = "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZoneName: "short",
    }).formatToParts(d);
    tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    /* runtime without formatToParts — leave tz empty */
  }
  return tz ? `${base} ${tz}` : base;
}

/** Plain en-US number with up to 4 fractional digits and thousands
 *  grouping (`1,234.5678`). Used by the Escrow pool summary cards
 *  in both the workbench and the /notes page — the helper lives
 *  here so the two views can't drift on rounding. */
export function formatNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
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
