"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { NetworkConfig } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "./network";

interface ActiveNetworkState {
  network: NetworkConfig;
  setNetwork(next: NetworkConfig): void;
}

const Ctx = createContext<ActiveNetworkState | null>(null);

/** Hook for the active network. Returns the config + a setter that
 *  triggers downstream re-init (vault adapter, future: wallet/RPC).
 *  Throws outside the provider — matches `useVault` so misuse fails
 *  loudly instead of silently dropping `setNetwork` calls. */
export function useActiveNetwork(): ActiveNetworkState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useActiveNetwork must be used inside <ActiveNetworkProvider>");
  return ctx;
}

/** Wraps the Pro app and holds the currently-active `NetworkConfig`.
 *  Initial value is `DEMO_NETWORK`; `NetworkSwitcher` writes via the
 *  setter, and consumers (today: `VaultProvider`) react to chainId
 *  changes by re-creating per-chain resources.
 *
 *  Most app surfaces still read `DEMO_NETWORK` directly because the
 *  switcher only exposes a single available network in v1; full
 *  propagation across DepositModal / OrderModal / WalletProvider
 *  lands as the network roster grows beyond one entry. */
export function ActiveNetworkProvider({ children }: { children: React.ReactNode }) {
  const [network, setNetworkState] = useState<NetworkConfig>(DEMO_NETWORK);

  const setNetwork = useCallback((next: NetworkConfig) => {
    setNetworkState((prev) => (prev.chainId === next.chainId ? prev : next));
  }, []);

  const value = useMemo<ActiveNetworkState>(
    () => ({ network, setNetwork }),
    [network, setNetwork],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
