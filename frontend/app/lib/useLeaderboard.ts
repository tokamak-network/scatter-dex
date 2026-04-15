"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getSharedOrderbookUrl } from "./config";

export type LeaderboardMetric = "count" | "verifiedCount" | "successRate";
export type LeaderboardWindow = "24h" | "7d" | "30d" | "all";

export interface LeaderboardRow {
  address: string;
  txCount: number;
  txCountVerified: number;
  lastSettleAt: number | null;
}

interface LeaderboardState {
  rows: LeaderboardRow[];
  loading: boolean;
  /** Set when the shared OB returns an error or is unreachable; the rows
   *  array stays empty in that case. */
  error: string | null;
  /** True when NEXT_PUBLIC_SHARED_ORDERBOOK_URL is unset — the dashboard
   *  shows a config hint instead of a "no data" empty state. */
  unconfigured: boolean;
}

const WINDOW_SECONDS: Record<LeaderboardWindow, number | null> = {
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
  "all": null,
};

/**
 * Fetches the shared-OB leaderboard for a given metric + time window.
 * Re-fetches when either changes, with a request-id guard so a slow
 * earlier call doesn't overwrite a later one.
 */
export function useLeaderboard(metric: LeaderboardMetric, window: LeaderboardWindow): LeaderboardState {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const baseUrl = getSharedOrderbookUrl();
  const unconfigured = !baseUrl;

  const fetchOnce = useCallback(async () => {
    if (!baseUrl) return;
    const myId = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const sec = WINDOW_SECONDS[window];
      const sinceParam = sec !== null ? `&since=${Math.floor(Date.now() / 1000) - sec}` : "";
      const res = await fetch(
        `${baseUrl.replace(/\/+$/, "")}/api/leaderboard?metric=${metric}${sinceParam}&limit=100`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (myId !== requestId.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (myId !== requestId.current) return;
      setRows(Array.isArray(body?.rows) ? body.rows : []);
    } catch (e) {
      if (myId !== requestId.current) return;
      setError(e instanceof Error ? e.message : "leaderboard fetch failed");
      setRows([]);
    } finally {
      if (myId === requestId.current) setLoading(false);
    }
  }, [baseUrl, metric, window]);

  useEffect(() => { fetchOnce(); }, [fetchOnce]);

  return { rows, loading, error, unconfigured };
}
