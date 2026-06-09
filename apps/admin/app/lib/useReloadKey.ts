"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** A reload counter for on-chain snapshot effects, with built-in retry.
 *
 *  `reload()` bumps the key immediately AND once more after a short delay. The
 *  retry absorbs a one-block wallet-RPC lag: right after a write's `tx.wait()`
 *  the connected wallet node can still serve the previous block, so an immediate
 *  re-read may return the stale value. The delayed second bump re-reads once the
 *  node has caught up — so a card's "Current:" reflects a successful write right
 *  away without the user having to refresh.
 *
 *  Pass `reload({ retry: false })` for background polling (a periodic refresh
 *  doesn't need the lag-absorbing second fetch — it would just double RPC load).
 *
 *  The pending retry timer is tracked in a ref and cleared on unmount and before
 *  scheduling a new one, so rapid successive reloads don't pile up overlapping
 *  timeouts or fire setState after unmount.
 *
 *  Usage: `const [reloadKey, reload] = useReloadKey();` — put `reloadKey` in the
 *  read effect's deps, call `reload()` from a write's onSuccess.
 */
export function useReloadKey(retryMs = 1500): [number, (opts?: { retry?: boolean }) => void] {
  const [reloadKey, setReloadKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const reload = useCallback(
    (opts?: { retry?: boolean }) => {
      setReloadKey((k) => k + 1);
      if (opts?.retry === false) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setReloadKey((k) => k + 1), retryMs);
    },
    [retryMs],
  );

  return [reloadKey, reload];
}
