/**
 * useAbortOnUnmount — returns a ref-hosted AbortController that's
 * aborted when the component unmounts. Also exposes a `mountedRef`
 * so post-await setState calls can bail out cleanly.
 *
 * Used by screens that fire network work from user events (submit
 * handlers, debounced effects) and need to keep the HTTP promise
 * chain from staying pinned to an unmounted component.
 *
 * Usage:
 *   const { makeController, mountedRef } = useAbortOnUnmount();
 *   // in the handler:
 *   const ctrl = makeController();
 *   try {
 *     await fetchWithTimeout(url, { parentSignal: ctrl.signal, ... });
 *   } finally {
 *     if (mountedRef.current) setSubmitting(false);
 *   }
 */
import { useEffect, useRef, useCallback } from 'react';

export interface AbortOnUnmountHandle {
  /** Aborts any previously-issued controller and returns a fresh one. */
  makeController: () => AbortController;
  /** `false` after unmount — guard post-await setState with this. */
  mountedRef: React.MutableRefObject<boolean>;
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
    // Cancel any prior in-flight call — e.g. a fast double-tap that
    // re-enters the handler before the first promise settles.
    controllerRef.current?.abort();
    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    return ctrl;
  }, []);

  return { makeController, mountedRef };
}
