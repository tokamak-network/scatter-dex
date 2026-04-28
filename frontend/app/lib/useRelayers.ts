"use client";

import { useState, useEffect, useCallback } from "react";
import {
  loadRelayersWithApiInfo,
  type RelayerApiInfo,
  type RelayerInfo,
  type RelayerOnChain,
  type RelayerProfile,
} from "@zkscatter/sdk/relayer";
import { getRelayerRegistryAddress } from "./config";
import { getReadProvider } from "./provider";

const provider = getReadProvider();

// Re-export SDK types so existing consumers (six pages under
// app/trade, app/relayer, app/relayer/leaderboard) keep working
// without touching their imports.
export type { RelayerApiInfo, RelayerInfo, RelayerOnChain, RelayerProfile };

/** Frontend-only orderbook payload — `useRelayers` doesn't fetch
 *  it, the relayer page polls it separately. Kept here so any
 *  consumer importing `RelayerOrderbook` from this module still
 *  resolves. */
export interface RelayerOrderbook {
  pair: string;
  sells: { maker: string; sellAmount: string; buyAmount: string }[];
  buys: { maker: string; sellAmount: string; buyAmount: string }[];
}

export function useRelayers() {
  const [relayers, setRelayers] = useState<RelayerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRelayers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const results = await loadRelayersWithApiInfo(getRelayerRegistryAddress(), provider);
      setRelayers(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch relayers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRelayers(); }, [fetchRelayers]);

  return { relayers, loading, error, refresh: fetchRelayers };
}
