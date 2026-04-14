/**
 * useAbortOnUnmount — returns a controller factory that's cleaned up
 * when the component unmounts, plus an `isMounted()` probe so
 * post-await setState calls can bail out cleanly.
 *
 * Usage:
 *   const { makeController, isMounted } = useAbortOnUnmount();
 *   const ctrl = makeController();
 *   try {
 *     await fetchWithTimeout(url, { parentSignal: ctrl.signal });
 *   } finally {
 *     if (isMounted()) setSubmitting(false);
 *   }
 */
import { useEffect, useRef, useCallback } from 'react';

export interface AbortOnUnmountHandle {
  /** Aborts any previously-issued controller and returns a fresh one.
   *  The auto-abort-prior behaviour doubles as a double-tap guard for
   *  user-event handlers. */
  makeController: () => AbortController;
  /** `true` until the component unmounts — call this before any
   *  post-await setState. Stable identity; safe to close over. */
  isMounted: () => boolean;
}

export function useAbortOnUnmount(): AbortOnUnmountHandle {
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const makeController = useCallback(() => {
    controllerRef.current?.abort();
    const ctrl = new AbortController();
    // If a handler kept running past unmount (await gap, interval
    // firing late) and tries to start a new request, hand it a
    // pre-aborted controller so downstream fetch bails out instantly.
    if (!mountedRef.current) ctrl.abort();
    controllerRef.current = ctrl;
    return ctrl;
  }, []);

  const isMounted = useCallback(() => mountedRef.current, []);

  return { makeController, isMounted };
}
