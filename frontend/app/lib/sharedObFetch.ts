"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getSharedOrderbookUrl } from "./config";

/**
 * Time windows used by the leaderboard + per-relayer trade-stats views.
 * Centralised so both UIs stay in lockstep — a new "90d" option added
 * here automatically propagates.
 */
export type SharedObWindow = "24h" | "7d" | "30d" | "all";

export const SHARED_OB_WINDOW_SECONDS: Record<SharedObWindow, number | null> = {
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
  "all": null,
};

export function windowToSince(window: SharedObWindow): number | null {
  const sec = SHARED_OB_WINDOW_SECONDS[window];
  return sec !== null ? Math.floor(Date.now() / 1000) - sec : null;
}

export interface SharedObFetchState<T> {
  data: T | null;
  loading: boolean;
  /** Populated when the shared OB returns an error or is unreachable; data stays null. */
  error: string | null;
  /** True when NEXT_PUBLIC_SHARED_ORDERBOOK_URL is unset. */
  unconfigured: boolean;
}

/**
 * Shared fetch hook for read-only shared-orderbook endpoints. Handles the
 * common plumbing: config-missing detection, request-id guard against
 * out-of-order responses, AbortSignal timeout, and unmount cleanup.
 *
 * The `buildPath` callback lets each caller construct the path (including
 * query string) from its own inputs. Return `null` to skip a fetch
 * (e.g. when an address argument is missing).
 */
export function useSharedObFetch<T>(
  buildPath: () => string | null,
  deps: ReadonlyArray<unknown>,
  options: { timeoutMs?: number } = {},
): SharedObFetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const baseUrl = getSharedOrderbookUrl();
  const unconfigured = !baseUrl;
  const timeoutMs = options.timeoutMs ?? 5000;

  const fetchOnce = useCallback(async () => {
    if (!baseUrl) return;
    const path = buildPath();
    if (path === null) {
      // Deps transitioned to "no fetch" (e.g. address became null). Clear
      // any lingering loading/error state from a previous fetch and bump
      // the request id so any still-in-flight response is ignored.
      requestId.current += 1;
      setLoading(false);
      setError(null);
      setData(null);
      return;
    }
    const myId = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${baseUrl.replace(/\/+$/, "")}${path}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (myId !== requestId.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as T;
      if (myId !== requestId.current) return;
      setData(body);
    } catch (e) {
      if (myId !== requestId.current) return;
      setError(e instanceof Error ? e.message : "fetch failed");
      setData(null);
    } finally {
      if (myId === requestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, timeoutMs, ...deps]);

  useEffect(() => {
    fetchOnce();
    return () => { requestId.current += 1; };
  }, [fetchOnce]);

  return { data, loading, error, unconfigured };
}
