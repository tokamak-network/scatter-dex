"use client";

import { useSharedObFetch, windowToSince, type SharedObWindow } from "./sharedObFetch";

export type TradeStatsWindow = SharedObWindow;

export interface TokenVolumeRow {
  token: string;
  totalSell: string;
  totalBuy: string;
  sellCount: number;
  buyCount: number;
}

export interface RelayerTradeStats {
  address: string;
  txCount: number;
  txCountVerified: number;
  /** Volume across all rows the relayer participated in. Includes
   *  unverified relayer-pushed rows — a malicious relayer can inflate
   *  this by pushing fake settlements. Prefer `volumeByTokenVerified`
   *  for public dashboards. */
  volumeByToken: TokenVolumeRow[];
  /** Verified-only counterpart of `volumeByToken`. Use this for any
   *  surface where a self-reported aggregate could be abused. */
  volumeByTokenVerified?: TokenVolumeRow[];
  pairs: Array<{ sellToken: string; buyToken: string; count: number }>;
  /** Verified-only counterpart of `pairs`. */
  pairsVerified?: Array<{ sellToken: string; buyToken: string; count: number }>;
  avgFeeBps: number | null;
  successRate: number | null;
  lastSettleAt: number | null;
}

export interface TradeStatsState {
  stats: RelayerTradeStats | null;
  loading: boolean;
  error: string | null;
  unconfigured: boolean;
}

/**
 * Fetches indexer-sourced trade activity for a given relayer address.
 * Independent of the relayer's own /api/info endpoint — works even when
 * that relayer is offline, and is the canonical source for cross-relayer
 * activity figures (trust-model §12: indexer push + verify).
 */
export function useRelayerTradeStats(
  address: string | null,
  window: TradeStatsWindow = "7d",
): TradeStatsState {
  const { data, loading, error, unconfigured } = useSharedObFetch<RelayerTradeStats>(
    () => {
      if (!address) return null;
      // Backend route allowlist is case-tolerant, but the table stores
      // addresses lowercased — a checksummed input would miss.
      const addr = address.toLowerCase();
      const since = windowToSince(window);
      const sinceParam = since !== null ? `?since=${since}` : "";
      return `/api/relayers/${addr}/stats${sinceParam}`;
    },
    [address, window],
  );
  return { stats: data, loading, error, unconfigured };
}
