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
  /** The chain the wallet is actually on right now (null when
   *  disconnected). Surfaced so a wrong-chain banner can tell the user
   *  *which* network they're on, not just which one they should be on. */
  currentChainId: number | null;
  /** Friendly name for `currentChainId` when known (e.g. "Localhost",
   *  "Ethereum"); null for unknown chains so the UI shows the raw id. */
  currentChainLabel: string | null;
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
      // EIP-3326 error code 4902 = "chain not configured". Add the
      // chain via wallet_addEthereumChain so the operator doesn't
      // have to enter RPC URL / chain ID by hand. Ethers v6 wraps
      // wallet errors in a "could not coalesce error" envelope and
      // the original 4902 lives at one of several nested paths
      // depending on the wallet — walk all of them rather than
      // committing to a single shape.
      const e = err as Record<string, unknown> & {
        error?: { code?: number };
        data?: { originalError?: { code?: number } };
      };
      const nestedCodes = [
        e?.code,
        e?.error?.code,
        e?.data?.originalError?.code,
        // Some wallets serialize the inner JSON-RPC error in
        // `info.error.code`; check there too.
        (e as { info?: { error?: { code?: number } } })?.info?.error?.code,
      ];
      const isUnrecognised =
        nestedCodes.includes(4902) ||
        // String fallback — ethers' UNKNOWN_ERROR coalesce wrap
        // sometimes loses the nested code on stringify but keeps
        // the message verbatim.
        (typeof (e?.message ?? "") === "string" &&
          /unrecognized chain id|chain.*not.*added|4902/i.test(String(e.message ?? "")));
      if (!isUnrecognised) {
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
    currentChainId: chainId,
    currentChainLabel: chainId !== null ? (KNOWN_CHAIN_NAMES[chainId] ?? null) : null,
    switchChain,
  };
}
