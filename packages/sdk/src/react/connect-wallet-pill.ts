"use client";

import { chainName, type NetworkConfig } from "../core";
import { shortAddr, useWallet } from "./wallet";

export interface ConnectWalletPillState {
  connected: boolean;
  shortAccount: string;
  walletName: string | null;
  connect: () => void;
  disconnect: () => void;
  connectError: string | null;
  networkLabel: string;
  wrongChain: boolean;
}

/** Bind `useWallet()` + the host app's `NetworkConfig` to the
 *  prop shape `ConnectWalletPillView` (in `@zkscatter/ui`)
 *  expects. Apps spread the result directly onto the view, so the
 *  per-app wrapper collapses to a one-liner instead of repeating
 *  the same glue. */
export function useConnectWalletPill(network: NetworkConfig): ConnectWalletPillState {
  const { account, walletName, connect, disconnect, connectError, chainId } =
    useWallet();
  return {
    connected: account !== null,
    shortAccount: shortAddr(account),
    walletName,
    connect,
    disconnect,
    connectError,
    networkLabel: network.name ?? chainName(network.chainId),
    wrongChain: chainId !== null && chainId !== network.chainId,
  };
}
