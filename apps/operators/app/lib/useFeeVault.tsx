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
  /** Error from the platform-fee read, distinct from the balances
   *  read because the two reads have different shapes and surface
   *  different UX (the fee is a single value rendered in one stat;
   *  balances are a list with per-row claim buttons). `null` while
   *  the read is in flight or has succeeded. */
  platformFeeError: string | null;
  /** Native ETH balance in the relayer's wallet (gas pool), in wei.
   *  `null` while loading / on RPC error. Shown alongside the
   *  FeeVault claimable balances so the operator has one view of
   *  their relayer's assets, but flagged as not-claimable since
   *  FeeVault tracks ERC20 only. */
  walletEthWei: bigint | null;
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
  const [platformFeeError, setPlatformFeeError] = useState<string | null>(null);
  const [walletEthWei, setWalletEthWei] = useState<bigint | null>(null);
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

  // Native ETH balance — read alongside the vault balances (same
  // tick trigger) so a successful claim that consumed gas refreshes
  // the gas-pool reading too. Errors are swallowed to a null state
  // because the wallet ETH balance is informational, not blocking;
  // the FeeVault read above carries the user-facing error banner.
  useEffect(() => {
    if (!account || !readProvider) {
      setWalletEthWei(null);
      return;
    }
    let cancelled = false;
    readProvider
      .getBalance(account)
      .then((wei) => { if (!cancelled) setWalletEthWei(wei); })
      .catch(() => { if (!cancelled) setWalletEthWei(null); });
    return () => { cancelled = true; };
  }, [account, readProvider, tick]);

  // Platform-fee read is account-independent and rarely changes
  // (owner-only `applyFeeChange` with a timelock), so we fetch it
  // once per vault address rather than on every account switch or
  // user-driven refresh.
  useEffect(() => {
    if (!vaultDeployed || !vaultAddress || !readProvider) {
      setPlatformFeeBps(null);
      setPlatformFeeError(null);
      return;
    }
    let cancelled = false;
    setPlatformFeeError(null);
    loadPlatformFeeBps(vaultAddress, readProvider)
      .then((bps) => { if (!cancelled) setPlatformFeeBps(bps); })
      .catch((e) => {
        if (cancelled) return;
        console.warn("Failed to load platformFeeBps", e);
        setPlatformFeeBps(null);
        setPlatformFeeError(unwrapEthersError(e));
      });
    return () => { cancelled = true; };
  }, [vaultDeployed, vaultAddress, readProvider]);

  const value = useMemo<FeeVaultState>(
    () => ({
      account, loading, balances, error, vaultDeployed,
      platformFeeBps, platformFeeError, walletEthWei, refresh,
    }),
    [
      account, loading, balances, error, vaultDeployed,
      platformFeeBps, platformFeeError, walletEthWei, refresh,
    ],
  );
  return <FeeVaultCtx.Provider value={value}>{children}</FeeVaultCtx.Provider>;
}

export function useFeeVault(): FeeVaultState {
  const ctx = useContext(FeeVaultCtx);
  if (!ctx) throw new Error("useFeeVault must be used inside <FeeVaultProvider>");
  return ctx;
}
