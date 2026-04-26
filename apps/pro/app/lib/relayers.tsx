"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadRelayersWithApiInfo,
  type RelayerInfo,
} from "@zkscatter/sdk/relayer";
import { DEMO_NETWORK } from "./network";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface RelayersState {
  relayers: RelayerInfo[];
  selected: RelayerInfo | null;
  loading: boolean;
  /** True when no on-chain registry is configured for the network
   *  (e.g. the placeholder DEMO_NETWORK). UI uses this to render
   *  "no registry" instead of an empty-list fallback. */
  registryConfigured: boolean;
  error: string | null;
  refresh(): void;
  select(address: string): void;
}

const RelayersCtx = createContext<RelayersState | null>(null);

export function useRelayers(): RelayersState {
  const ctx = useContext(RelayersCtx);
  if (!ctx) throw new Error("useRelayers must be used inside <RelayersProvider>");
  return ctx;
}

export function RelayersProvider({ children }: { children: React.ReactNode }) {
  const { readProvider } = useWallet();
  const [relayers, setRelayers] = useState<RelayerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  const registryAddress = DEMO_NETWORK.contracts.relayerRegistry;
  const registryConfigured =
    registryAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase();

  const refresh = useCallback(() => {
    if (!registryConfigured) {
      setRelayers([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRelayersWithApiInfo(registryAddress, readProvider)
      .then((list) => {
        if (cancelled) return;
        setRelayers(list);
        // Auto-select the first online relayer if nothing's chosen.
        setSelectedAddress((prev) =>
          prev ?? list.find((r) => r.online)?.address ?? list[0]?.address ?? null,
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load relayers");
        setRelayers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [registryAddress, registryConfigured, readProvider]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected = useMemo(
    () => relayers.find((r) => r.address === selectedAddress) ?? null,
    [relayers, selectedAddress],
  );

  const select = useCallback((address: string) => {
    setSelectedAddress(address);
  }, []);

  const value = useMemo<RelayersState>(
    () => ({
      relayers,
      selected,
      loading,
      registryConfigured,
      error,
      refresh,
      select,
    }),
    [relayers, selected, loading, registryConfigured, error, refresh, select],
  );

  return <RelayersCtx.Provider value={value}>{children}</RelayersCtx.Provider>;
}
