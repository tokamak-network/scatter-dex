"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadFeeVaultBalances,
  loadPlatformFeeBps,
  unwrapEthersError,
  type FeeVaultBalance,
} from "@zkscatter/sdk/relayer";
import { DEMO_NETWORK } from "./network";

export interface FeeVaultState {
  account: string | null;
  loading: boolean;
  balances: FeeVaultBalance[];
  error: string | null;
  /** True when the FeeVault address is configured on the network.
   *  When false, render the "not deployed yet" UX instead of
   *  attempting RPC reads against the zero address. */
  vaultDeployed: boolean;
  /** Platform-fee cut in basis points, skimmed on every `claim()`.
   *  `null` while the one-shot read is in flight or the vault is
   *  unconfigured. Doesn't change with the connected account, so it
   *  lives on the provider rather than being re-fetched per page. */
  platformFeeBps: number | null;
  /** Re-fetch every token balance. Call after a successful claim
   *  so the row drops back to zero without a page reload. */
  refresh: () => void;
}

const FeeVaultCtx = createContext<FeeVaultState | null>(null);

export function FeeVaultProvider({ children }: { children: ReactNode }) {
  const { account, readProvider } = useWallet();
  const [balances, setBalances] = useState<FeeVaultBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platformFeeBps, setPlatformFeeBps] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const vaultAddress = DEMO_NETWORK.contracts.feeVault;
  const vaultDeployed = isConfiguredAddress(vaultAddress);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Drop stale balances the moment the operator account or
  // configured vault changes, so an account switch never briefly
  // renders the previous account's amounts before the new fetch
  // resolves. Kept separate from the fetch effect below so that a
  // user-driven `refresh()` (tick bump) doesn't flash the table to
  // empty between fetches.
  useEffect(() => {
    setBalances([]);
    setError(null);
  }, [account, vaultAddress]);

  useEffect(() => {
    if (!account || !vaultDeployed || !vaultAddress) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadFeeVaultBalances(vaultAddress, account, DEMO_NETWORK.tokens, readProvider)
      .then((b) => { if (!cancelled) setBalances(b); })
      .catch((e) => {
        if (cancelled) return;
        setError(unwrapEthersError(e));
        console.error("Failed to load FeeVault balances", e);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [account, vaultDeployed, vaultAddress, readProvider, tick]);

  // Platform-fee read is account-independent and rarely changes
  // (owner-only `applyFeeChange` with a timelock), so we fetch it
  // once per vault address rather than on every account switch or
  // user-driven refresh.
  useEffect(() => {
    if (!vaultDeployed || !vaultAddress || !readProvider) {
      setPlatformFeeBps(null);
      return;
    }
    let cancelled = false;
    loadPlatformFeeBps(vaultAddress, readProvider)
      .then((bps) => { if (!cancelled) setPlatformFeeBps(bps); })
      .catch((e) => {
        if (cancelled) return;
        console.warn("Failed to load platformFeeBps", e);
        setPlatformFeeBps(null);
      });
    return () => { cancelled = true; };
  }, [vaultDeployed, vaultAddress, readProvider]);

  const value = useMemo<FeeVaultState>(
    () => ({ account, loading, balances, error, vaultDeployed, platformFeeBps, refresh }),
    [account, loading, balances, error, vaultDeployed, platformFeeBps, refresh],
  );
  return <FeeVaultCtx.Provider value={value}>{children}</FeeVaultCtx.Provider>;
}

export function useFeeVault(): FeeVaultState {
  const ctx = useContext(FeeVaultCtx);
  if (!ctx) throw new Error("useFeeVault must be used inside <FeeVaultProvider>");
  return ctx;
}
