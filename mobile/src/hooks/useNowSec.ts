import { useEffect, useState } from 'react';

/**
 * useNowSec — returns the current unix-second, refreshed while `enabled`
 * is true so subscribers re-render without an always-on setInterval.
 *
 * Pass `enabled=false` when nothing on screen depends on the tick
 * (no locked claims, etc.) to avoid a standing 30s-wakeup on every
 * ClaimScreen mount.
 */
export function useNowSec(enabled: boolean, intervalMs: number = 30_000): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return nowSec;
}
