"use client";

import { useEffect, useRef } from "react";

export interface UseTimedRefreshOptions {
  /** Callback to invoke on each tick + on visibility change. Should
   *  be a stable reference (wrap in `useCallback`) — the hook re-
   *  subscribes whenever this function identity changes. */
  refresh: () => void | Promise<void>;
  /** Polling interval in milliseconds. Choose with the consumer's
   *  freshness needs in mind: a list that operators expect to see
   *  new entries in within ~30s can poll at 15–30s; a status the
   *  user is actively waiting on (e.g. just-issued cert) can poll
   *  at 5–10s and stop via `enabled` once terminal. */
  intervalMs: number;
  /** Disable polling without unmounting. Use this to stop polling
   *  once the watched state reaches a terminal value (e.g. cert
   *  verified, approval granted) so we don't keep hammering the RPC
   *  forever on a tab the user left open. Default true. */
  enabled?: boolean;
  /** Also call `refresh` immediately when the document becomes
   *  visible. Critical for the "user came back to this tab after
   *  doing something in another tab" UX — the manual Refresh
   *  button this replaces existed specifically for that case.
   *  Default true. */
  refreshOnVisible?: boolean;
}

export interface StartTimedRefreshOptions {
  refresh: () => void | Promise<void>;
  intervalMs: number;
  refreshOnVisible: boolean;
  /** Injected for testability — defaults to the real browser primitives. */
  setInterval?: (cb: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  isHidden?: () => boolean;
  addVisibilityListener?: (cb: () => void) => () => void;
}

/** Pure scheduler the React hook delegates to. Extracted so the
 *  tick/visibility behaviour can be unit-tested without spinning up
 *  a DOM — every browser primitive is injectable. Returns a teardown
 *  that cancels the interval + removes the listener. */
export function startTimedRefresh(opts: StartTimedRefreshOptions): () => void {
  const setI = opts.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as unknown as number);
  const clearI = opts.clearInterval ?? ((id) => globalThis.clearInterval(id));
  const isHidden = opts.isHidden ?? (() => {
    if (typeof document === "undefined") return false;
    return document.visibilityState === "hidden";
  });

  const tick = () => {
    if (isHidden()) return;
    void opts.refresh();
  };
  const id = setI(tick, opts.intervalMs);

  let removeListener: (() => void) | null = null;
  if (opts.refreshOnVisible) {
    const onVis = () => {
      if (!isHidden()) void opts.refresh();
    };
    if (opts.addVisibilityListener) {
      removeListener = opts.addVisibilityListener(onVis);
    } else if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
      removeListener = () => document.removeEventListener("visibilitychange", onVis);
    }
  }

  return () => {
    clearI(id);
    removeListener?.();
  };
}

/** Periodically calls `refresh` + also on document visibility →
 *  visible. Skips the call while the document is hidden so a
 *  background tab doesn't poll the RPC every N seconds for hours.
 *
 *  Why polling instead of `contract.on` event subscriptions:
 *  ethers v6's filter-subscription path is unreliable on anvil (it
 *  silently stops firing — repo memory `feedback_contract_on_unreliable`)
 *  and the consumers here read view functions or run aggregate
 *  queries that don't have a single corresponding event anyway
 *  (relayer list is composed of N reads; approval state is one
 *  struct read; identity is a view call into IdentityGate). A
 *  uniform polling cadence is simpler, observable, and easy to
 *  reason about for ops. */
export function useTimedRefresh({
  refresh,
  intervalMs,
  enabled = true,
  refreshOnVisible = true,
}: UseTimedRefreshOptions): void {
  // Pin the latest `refresh` in a ref so the timer + visibility
  // listener always call the freshest function without re-arming
  // the interval (and re-running the immediate refresh) on every
  // render that passed a new inline arrow function.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    return startTimedRefresh({
      refresh: () => refreshRef.current(),
      intervalMs,
      refreshOnVisible,
    });
  }, [enabled, intervalMs, refreshOnVisible]);
}
