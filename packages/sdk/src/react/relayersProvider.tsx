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
import { useTimedRefresh } from "./useTimedRefresh";

/** Poll cadence for the relayer registry. 30s balances "new relayer
 *  appears within half a minute" with "don't hammer the RPC". The
 *  visibility-change handler in `useTimedRefresh` catches tab focus
 *  immediately so the perceived latency is much lower whenever the
 *  user actually switches back. */
const RELAYERS_POLL_INTERVAL_MS = 30_000;

export interface RelayersState {
  relayers: RelayerInfo[];
  selected: RelayerInfo | null;
  loading: boolean;
  /** True when an on-chain registry IS configured for the network.
   *  False for unconfigured / placeholder addresses (e.g. a demo
   *  network with a zero-address relayer registry). UI branches on
   *  `!registryConfigured` to render a "no registry" state instead
   *  of an empty-list fallback. */
  registryConfigured: boolean;
  error: string | null;
  /** Unix-ms timestamp of the most recent successful fetch, or
   *  `null` until the first one completes. Surface this in UI to
   *  show "live • Xs ago" so the polling cadence introduced by
   *  `useTimedRefresh` is visible to the user — otherwise they
   *  have no signal that the data isn't stale. Updated on every
   *  successful refresh, NOT on failures (so the displayed age
   *  stays accurate during an RPC outage rather than freezing
   *  optimistically). */
  lastRefreshedAt: number | null;
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
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
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
        setLastRefreshedAt(Date.now());
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

  // Live-refresh: re-fetch the relayer list every 30s and immediately
  // on tab-focus. Without this the UI shows stale state until the user
  // manually triggers a refresh — operators registering new relayers
  // would not appear on Pay/Pro/operators pages until everyone hard-
  // refreshed.
  useTimedRefresh({
    refresh,
    intervalMs: RELAYERS_POLL_INTERVAL_MS,
    enabled: registryConfigured,
  });
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
      lastRefreshedAt,
      refresh,
      select,
    }),
    [relayers, selected, loading, registryConfigured, error, lastRefreshedAt, refresh, select],
  );

  return <RelayersCtx.Provider value={value}>{children}</RelayersCtx.Provider>;
}
