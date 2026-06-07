"use client";

import {
  useWhitelistedTokens,
  type UseWhitelistedTokensResult,
} from "./useWhitelistedTokens";
import { useWallet } from "./wallet";
import type { NetworkConfig } from "../core/network";

export interface UseNetworkTokensOptions {
  /** Skip the on-chain fetch and stay on `network.tokens`. Default
   *  enabled (see {@link useWhitelistedTokens}). */
  enabled?: boolean;
}

/** App-convenience wrapper over {@link useWhitelistedTokens}: pulls the
 *  read provider from the wallet context and the pool/settlement
 *  addresses + env fallback from a `NetworkConfig`, so an app component
 *  is a single line:
 *
 *  ```ts
 *  const { tokens, loading } = useNetworkTokens(DEMO_NETWORK);
 *  ```
 *
 *  Returns the on-chain Pool∩Settlement whitelist (tokens usable for the
 *  full deposit→settle→claim flow), with `network.tokens`
 *  (`NEXT_PUBLIC_TOKENS`) as the metadata overlay + fallback. Must be
 *  used within the SDK `<WalletProvider>` (every app already is). For an
 *  admin "which tokens are whitelisted anywhere" view, fetch the union
 *  directly instead — this returns the intersection. */
export function useNetworkTokens(
  network: NetworkConfig,
  options: UseNetworkTokensOptions = {},
): UseWhitelistedTokensResult {
  const { readProvider } = useWallet();
  return useWhitelistedTokens({
    provider: readProvider,
    poolAddress: network.contracts.commitmentPool,
    settlementAddress: network.contracts.privateSettlement,
    fallback: network.tokens,
    enabled: options.enabled,
  });
}
