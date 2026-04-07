"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { RELAYER_REGISTRY_ABI } from "./contracts";
import { getRelayerRegistryAddress } from "./config";
import { getReadProvider } from "./provider";

const provider = getReadProvider();

export interface RelayerOnChain {
  address: string;
  url: string;
  fee: number;       // basis points
  bond: bigint;
  registeredAt: number;
  exitRequestedAt: number;
  active: boolean;
}

export interface RelayerApiInfo {
  name: string;
  version: string;
  address: string;
  fee: number;
  orderCount: number;
  settlement: string;
}

export interface RelayerOrderbook {
  pair: string;
  sells: { maker: string; sellAmount: string; buyAmount: string }[];
  buys: { maker: string; sellAmount: string; buyAmount: string }[];
}

export interface RelayerInfo extends RelayerOnChain {
  api?: RelayerApiInfo;
  online: boolean;
}

export function useRelayers() {
  const [relayers, setRelayers] = useState<RelayerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRelayers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const registry = new ethers.Contract(
        getRelayerRegistryAddress(),
        RELAYER_REGISTRY_ABI,
        provider
      );

      // Get active relayer addresses
      const activeAddresses: string[] = await registry.getActiveRelayers();

      // Fetch on-chain details for each
      const onChainData: RelayerOnChain[] = await Promise.all(
        activeAddresses.map(async (addr) => {
          const r = await registry.relayers(addr);
          return {
            address: addr,
            url: r.url,
            fee: Number(r.fee),
            bond: r.bond,
            registeredAt: Number(r.registeredAt),
            exitRequestedAt: Number(r.exitRequestedAt),
            active: r.active,
          };
        })
      );

      // Probe each relayer's API (with timeout)
      const results: RelayerInfo[] = await Promise.all(
        onChainData.map(async (r) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          try {
            const res = await fetch(`${r.url}/api/info`, { signal: controller.signal });
            if (!res.ok) return { ...r, online: false };
            const api: RelayerApiInfo = await res.json();
            return { ...r, api, online: true };
          } catch {
            return { ...r, online: false };
          } finally {
            clearTimeout(timeout);
          }
        })
      );

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

export async function fetchOrderbook(relayerUrl: string, pair: string): Promise<RelayerOrderbook> {
  const res = await fetch(`${relayerUrl}/api/orderbook/${pair}`);
  if (!res.ok) throw new Error(`Failed to fetch orderbook: ${res.statusText}`);
  return res.json();
}
