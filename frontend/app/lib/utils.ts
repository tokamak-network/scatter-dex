import { ethers } from "ethers";

export function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatBond(bond: bigint, decimals = 2): string {
  const val = Number(ethers.formatEther(bond));
  return val % 1 === 0 ? `${val} ETH` : `${val.toFixed(decimals)} ETH`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function timeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

/**
 * Format a token amount for display: `formatUnits` then truncate (no
 * rounding) to at most `maxFractionDigits`. The trailing `.` is stripped
 * when the truncated fraction is empty (e.g. when `maxFractionDigits === 0`
 * or the value has no fractional part). Use this anywhere a balance / fee
 * is shown in the UI.
 */
export function formatTokenAmount(
  value: bigint,
  decimals: number,
  maxFractionDigits = 6,
): string {
  const s = ethers.formatUnits(value, decimals);
  const [int, frac] = s.split(".");
  if (!frac || maxFractionDigits <= 0) return int;
  const truncated = frac.slice(0, maxFractionDigits);
  return truncated.length > 0 ? `${int}.${truncated}` : int;
}

/**
 * Pull the most descriptive message out of an ethers v6 error
 * (`shortMessage` → `reason` → nested `info.error.message` → `.message`)
 * with a generic fallback. Caller should always also `console.warn(e)`
 * so the full error stays available for debugging.
 */
export function extractEthersErrorMessage(e: unknown, fallback = "Request failed"): string {
  if (e && typeof e === "object") {
    const r = e as Record<string, unknown>;
    const candidates = [
      r.shortMessage,
      r.reason,
      (r.info as Record<string, unknown> | undefined)?.error
        && ((r.info as { error: Record<string, unknown> }).error.message),
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
  }
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Human time-until for an expiry unix-seconds timestamp. */
export function formatExpiry(ts: number): string {
  const delta = ts - Math.floor(Date.now() / 1000);
  if (delta <= 0) return "expired";
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
