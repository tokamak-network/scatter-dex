import { ethers } from "ethers";
import type { PayoutRecipient } from "@zkscatter/sdk/zk";

/** Convert a token bigint (as stored in `note.token`) to its
 *  20-byte hex address. Lowercased so it compares directly to
 *  `LAUNCH_TOKENS[symbol].address.toLowerCase()`. */
export function tokenBigIntToAddress(token: bigint): string {
  return "0x" + token.toString(16).padStart(40, "0");
}

export interface RecipientRow {
  name: string;
  address: string;
  amount: string;
}

/** Strip CSV-breaking characters from a free-form label. The wizard's
 *  CSV parser is `line.split(",")` with no quoting, so a comma or
 *  newline in the label would shift columns silently. */
export function csvSafeLabel(label: string): string {
  return (label || "").replace(/[,\n\r]/g, " ").trim();
}

/** Local-timezone `YYYY-MM-DD` for `<input type="date">` values.
 *  Locale-free format avoids the SSR/client locale split. */
export function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Local-timezone `YYYY-MM-DDTHH:mm:ss` for `<input type="datetime-local"
 *  step="1">` values. Mirrors `toIsoDate` but carries time-of-day so the
 *  claim schedule can pin a recipient unlock to the second. */
export function toIsoDateTimeSec(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

/** UTC `YYYY-MM-DD HH:mm UTC` stamp. Used wherever an SSR/client
 *  locale split would cause hydration mismatch. Empty string for
 *  undefined/zero so callers can render without conditional gating. */
export function formatUtcStamp(unixSec: number | undefined): string {
  if (!unixSec) return "";
  const iso = new Date(unixSec * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Local-timezone `YYYY-MM-DD HH:mm` stamp. Used for user-facing
 *  moments (claim time, etc.) where the operator expects to see their
 *  own clock, not UTC. Reads `Date` directly — when the input depends
 *  on the current wall clock (e.g. `Date.now()`), gate the call behind
 *  a mounted/`useEffect` flag so server-rendered HTML matches the
 *  client. Stamps derived from stable inputs (record timestamps) are
 *  safe to render in SSR. */
export function formatLocalStamp(unixSec: number | undefined): string {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/** Same as {@link formatLocalStamp} but with second-level precision —
 *  for surfaces where the recipient needs to know the exact unlock
 *  moment (claim screen) rather than a wall-clock-friendly minute. */
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

/** "5m ago" / "2h ago" relative-time formatter. */
export function formatRelativeAgo(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Parse a free-form amount string into a JS number. Strips commas,
 *  underscores, and whitespace (all common in spreadsheet exports);
 *  returns NaN on anything that isn't a plain decimal so the caller
 *  can fall back without producing a silently-wrong total. Mirrors
 *  what the wizard's Recipients step does on each row. */
export function parseAmount(input: string): number {
  const cleaned = input.replace(/[,_\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return parseFloat(cleaned);
}

/** Parse the wizard's textarea rows into the shape `splitPayout` and
 *  `dryRunSettle` both consume. Throws on the first invalid row so
 *  callers fall back to an empty plan rather than producing batches
 *  whose totals diverge from what gets settled. Strips
 *  thousands/underscore separators from amounts. */
export function parseRecipientRows(
  rows: readonly RecipientRow[],
  decimals: number,
  claimFromIso: string,
): PayoutRecipient[] {
  const releaseTime = BigInt(Math.floor(new Date(claimFromIso).getTime() / 1000));
  return rows.map((r) => {
    const cleaned = r.amount.replace(/[,_\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(cleaned)) {
      throw new Error(`invalid amount: ${r.amount}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
      throw new Error(`invalid address: ${r.address}`);
    }
    return {
      recipient: r.address,
      amount: ethers.parseUnits(cleaned, decimals),
      releaseTime,
    };
  });
}
