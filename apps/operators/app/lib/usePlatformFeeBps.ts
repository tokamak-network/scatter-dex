/**
 * Read `FeeVault.platformFeeBps()` for the configured FeeVault address.
 *
 * Used by the Fee card and Recent settlements to display a "net
 * after platform cut" figure alongside the gross fee the relayer
 * recorded. The value rarely changes on-chain (1-day timelock) so a
 * single read per mount is sufficient — callers wanting a fresh
 * read can remount or call again on tab focus.
 */

"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "./network";

const FEE_VAULT_ABI = [
  "function platformFeeBps() external view returns (uint256)",
];

export interface PlatformFeeBpsState {
  /** bps value as read from on-chain, or null when not yet loaded /
   *  unavailable (vault not configured, RPC failed). Callers default
   *  to "show gross only" when null. */
  bps: number | null;
  loading: boolean;
  error: string | null;
}

export function usePlatformFeeBps(): PlatformFeeBpsState {
  const { readProvider } = useWallet();
  const vault = DEMO_NETWORK.contracts.feeVault;
  const [state, setState] = useState<PlatformFeeBpsState>({
    bps: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!readProvider || !vault || !isConfiguredAddress(vault)) {
      setState({ bps: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const c = new ethers.Contract(vault, FEE_VAULT_ABI, readProvider);
    (c.platformFeeBps() as Promise<bigint>)
      .then((raw) => {
        if (cancelled) return;
        setState({ bps: Number(raw), loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[usePlatformFeeBps] read failed", err);
        setState({
          bps: null,
          loading: false,
          error: err instanceof Error ? err.message : "RPC failed",
        });
      });
    return () => { cancelled = true; };
  }, [readProvider, vault]);

  return state;
}

/** Apply the platform cut to a gross fee amount and return the
 *  relayer's net. `bps` of 500 means platform keeps 5%. Returns
 *  `null` when `bps` is null, NaN, or out of the on-chain `[0,10000]`
 *  range so callers can render "—" / fall back to gross-only instead
 *  of showing a negative or wildly inflated net (e.g. a buggy read
 *  returning 99_999 would otherwise zero out every row). */
export function netAfterPlatformFee(grossWei: string, bps: number | null): string | null {
  if (bps === null || !Number.isFinite(bps) || bps < 0 || bps > 10_000) return null;
  try {
    const gross = BigInt(grossWei);
    const platform = (gross * BigInt(bps)) / 10_000n;
    return (gross - platform).toString();
  } catch {
    return null;
  }
}
