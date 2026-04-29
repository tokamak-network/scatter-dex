"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isConfiguredAddress } from "../core/addresses";
import { loadRelayersWithApiInfo, type RelayerInfo } from "../relayer";
import { useWallet } from "./wallet";

export interface RelayersState {
  relayers: RelayerInfo[];
  selected: RelayerInfo | null;
  loading: boolean;
  /** True when no on-chain registry is configured for the network
   *  (e.g. a placeholder demo network). UI uses this to render
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

export interface RelayersProviderProps {
  /** RelayerRegistry address for the active network. The provider
   *  treats unconfigured (`isConfiguredAddress` false) addresses as
   *  "no registry" — render an empty list with `registryConfigured`
   *  flipped so the UI can branch on that. */
  registryAddress: string;
  children: ReactNode;
}

/** Loads the relayer registry, exposes the list + a current
 *  selection, and auto-picks the first online relayer (or the first
 *  relayer if none are online). Apps thin-wrap this to source
 *  `registryAddress` from their own network config. */
export function RelayersProvider({
  registryAddress,
  children,
}: RelayersProviderProps) {
  const { readProvider } = useWallet();
  const [relayers, setRelayers] = useState<RelayerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  // Bumping this triggers a re-fetch from the effect below.
  const [refreshTick, setRefreshTick] = useState(0);

  const registryConfigured = isConfiguredAddress(registryAddress);

  // Fetch lives inside the effect so its returned cleanup actually
  // runs on dep change / unmount — a useCallback wrapper would have
  // its returned cleanup discarded by React.
  useEffect(() => {
    if (!registryConfigured) {
      setRelayers([]);
      setLoading(false);
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
        // Auto-select the first online relayer when nothing's
        // chosen, or when the previously-selected relayer is no
        // longer in the list.
        setSelectedAddress((prev) => {
          if (prev && list.some((r) => r.address === prev)) return prev;
          return list.find((r) => r.online)?.address ?? list[0]?.address ?? null;
        });
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
    // `registryConfigured` is derived from `registryAddress`; omit
    // from deps to avoid a redundant dep entry.
  }, [registryAddress, readProvider, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);
  const select = useCallback((address: string) => {
    setSelectedAddress(address);
  }, []);

  const selected = useMemo(
    () => relayers.find((r) => r.address === selectedAddress) ?? null,
    [relayers, selectedAddress],
  );

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
