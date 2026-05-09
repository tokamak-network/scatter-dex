"use client";

import { useCallback } from "react";
import { chainName, KNOWN_CHAIN_NAMES, type NetworkConfig } from "../core";
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
  /** Ask the wallet to switch to `network.chainId`. Falls back to
   *  `wallet_addEthereumChain` when the wallet doesn't have the
   *  network configured (EIP-1193 error code 4902). Resolves on
   *  user-accept, rejects on user-cancel; the WalletProvider's
   *  `chainChanged` listener flips `wrongChain` automatically. */
  switchChain: () => Promise<void>;
}

/** Bind `useWallet()` + the host app's `NetworkConfig` to the
 *  prop shape `ConnectWalletPillView` (in `@zkscatter/ui`)
 *  expects. Apps spread the result directly onto the view, so the
 *  per-app wrapper collapses to a one-liner instead of repeating
 *  the same glue. */
export function useConnectWalletPill(network: NetworkConfig): ConnectWalletPillState {
  const { account, walletName, connect, disconnect, connectError, chainId, provider } =
    useWallet();

  const switchChain = useCallback(async () => {
    if (!provider) {
      // No wallet yet — defer to the connect flow (which will
      // prompt for permission AND surface the chain selector).
      connect();
      return;
    }
    const hexId = "0x" + network.chainId.toString(16);
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: hexId }]);
    } catch (err) {
      // EIP-3326 error code 4902 = chain not configured. Re-derive
      // an addEthereumChain payload from `NetworkConfig` so the
      // wallet picks it up without the operator having to enter
      // RPC URL / chain ID by hand.
      const code = (err as { code?: number; data?: { originalError?: { code?: number } } })?.code
        ?? (err as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
      if (code !== 4902 && code !== -32603) {
        throw err;
      }
      await provider.send("wallet_addEthereumChain", [
        {
          chainId: hexId,
          chainName: network.name ?? KNOWN_CHAIN_NAMES[network.chainId] ?? `Chain ${network.chainId}`,
          rpcUrls: [network.rpcUrl],
          // Local / dev chains don't have an explorer; spread to
          // skip the field entirely rather than send `[undefined]`
          // which some wallets reject.
          ...(network.explorerBase ? { blockExplorerUrls: [network.explorerBase] } : {}),
          // Native currency ETH is the safe assumption across the
          // chains we ship (Ethereum / Sepolia / anvil / Optimism /
          // Base). Override here once a non-ETH chain ships.
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        },
      ]);
      // Some wallets auto-switch after add; others require a
      // follow-up switch call. Try once more — if it still fails,
      // the operator will at least be on the network they just
      // accepted.
      try {
        await provider.send("wallet_switchEthereumChain", [{ chainId: hexId }]);
      } catch {
        /* swallowed — wallet may already be on the new chain */
      }
    }
  }, [provider, network, connect]);

  return {
    connected: account !== null,
    shortAccount: shortAddr(account),
    walletName,
    connect,
    disconnect,
    connectError,
    networkLabel: network.name ?? chainName(network.chainId),
    wrongChain: chainId !== null && chainId !== network.chainId,
    switchChain,
  };
}
