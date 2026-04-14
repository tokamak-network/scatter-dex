import { ethers } from 'ethers';

/** Truncate address/hash: 0x1234...abcd */
export function shortAddr(addr: string, prefixLen = 6, suffixLen = 4): string {
  if (!addr || addr.length < prefixLen + suffixLen + 3) return addr || '—';
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}

/** Format a pre-formatted decimal string to 4 decimal places (string truncation, no float precision loss). */
export function formatBalance(value: string): string {
  if (!value || value === '0') return '0';
  const dotIdx = value.indexOf('.');
  if (dotIdx === -1) return value;
  const truncated = value.slice(0, dotIdx + 5);
  if (parseFloat(truncated) === 0) return '< 0.0001';
  return truncated;
}

/** Format wei to human-readable with string truncation (no float precision loss). */
export function formatAmount(wei: string): string {
  const formatted = ethers.formatEther(wei);
  const dotIdx = formatted.indexOf('.');
  if (dotIdx === -1) return formatted;
  const truncated = formatted.slice(0, dotIdx + 5);
  if (parseFloat(truncated) === 0 && BigInt(wei) > 0n) return '< 0.0001';
  return truncated;
}

/** Format timestamp (ms) to YYYY-MM-DD HH:mm (cross-platform safe). */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** BigInt → 0x-prefixed bytes32 hex string. */
export function toBytes32Hex(value: string | bigint): string {
  return '0x' + BigInt(value).toString(16).padStart(64, '0');
}

/** Strip thousands separators from a user-entered decimal string
 *  (`"1,850.25"` → `"1850.25"`). Keeps the original precision so the
 *  return value is still safe to pass to `ethers.parseUnits`. */
export function stripThousandsSep(str: string): string {
  return str.replace(/,/g, '');
}

/** Parse a user-entered decimal string that may contain thousands
 *  separators to a number. Returns `NaN` for empty / unparseable
 *  input so callers can early-return on `!Number.isFinite`. */
export function parseHumanNumber(str: string): number {
  return parseFloat(stripThousandsSep(str));
}

// Pre-built formatter — constructing Intl.DateTimeFormat per call is
// measurably slow on older Android devices.
const ABSOLUTE_DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** Relative time for activity feeds: "12m ago", "3h ago", "Yesterday", "Jul 18".
 *  `timestampSec` is Unix seconds (matches block.timestamp). `nowMs` is
 *  milliseconds (matches Date.now()) — the unit mismatch is deliberate:
 *  passing seconds-since-epoch here would make everything look
 *  "Just now".
 */
export function formatRelativeTime(timestampSec: number, nowMs: number = Date.now()): string {
  const deltaMs = nowMs - timestampSec * 1000;
  if (deltaMs < 0) return 'Just now';
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return ABSOLUTE_DATE_FMT.format(new Date(timestampSec * 1000));
}
