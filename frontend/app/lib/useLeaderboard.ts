"use client";

import { useSharedObFetch, windowToSince, type SharedObWindow } from "./sharedObFetch";

export type LeaderboardMetric = "count" | "verifiedCount" | "successRate";
export type LeaderboardWindow = SharedObWindow;

export interface LeaderboardRow {
  address: string;
  txCount: number;
  txCountVerified: number;
  lastSettleAt: number | null;
}

interface LeaderboardResponse {
  metric: LeaderboardMetric;
  since: number | null;
  count: number;
  rows: LeaderboardRow[];
}

export interface LeaderboardState {
  rows: LeaderboardRow[];
  loading: boolean;
  error: string | null;
  unconfigured: boolean;
}

/**
 * Fetches the shared-OB leaderboard for a given metric + time window.
 * Thin wrapper around useSharedObFetch — all the request-id / timeout /
 * unmount plumbing is centralised there.
 */
export function useLeaderboard(metric: LeaderboardMetric, window: LeaderboardWindow): LeaderboardState {
  const { data, loading, error, unconfigured } = useSharedObFetch<LeaderboardResponse>(
    () => {
      const since = windowToSince(window);
      const sinceParam = since !== null ? `&since=${since}` : "";
      return `/api/leaderboard?metric=${metric}${sinceParam}&limit=100`;
    },
    [metric, window],
    { timeoutMs: 8000 },
  );
  return {
    rows: data?.rows ?? [],
    loading,
    error,
    unconfigured,
  };
}
