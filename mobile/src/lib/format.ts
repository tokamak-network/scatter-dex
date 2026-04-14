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

/** Relative time for activity feeds: "12m ago", "3h ago", "Yesterday", "Jul 18". */
export function formatRelativeTime(timestampSec: number, now: number = Date.now()): string {
  const deltaMs = now - timestampSec * 1000;
  if (deltaMs < 0) return 'Just now';
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  const d = new Date(timestampSec * 1000);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
