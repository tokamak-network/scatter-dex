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
