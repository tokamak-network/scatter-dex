"use client";

import {
  useWhitelistedTokens,
  type UseWhitelistedTokensResult,
} from "./useWhitelistedTokens";
import { useWallet } from "./wallet";
import type { NetworkConfig } from "../core/network";

export interface UseNetworkTokensOptions {
  /** Enable the on-chain fetch. When false, the hook stays on
   *  `network.tokens`. Default true (see {@link useWhitelistedTokens}). */
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
 *  directly instead — this returns the intersection.
 *
 *  `network` is accepted as nullable so a caller that hasn't resolved
 *  the active network yet (initialization / disconnected wallet) gets a
 *  graceful empty list with the fetch disabled, instead of a TypeError. */
export function useNetworkTokens(
  network: NetworkConfig | null | undefined,
  options: UseNetworkTokensOptions = {},
): UseWhitelistedTokensResult {
  const { readProvider } = useWallet();
  return useWhitelistedTokens({
    provider: readProvider,
    poolAddress: network?.contracts.commitmentPool ?? "",
    settlementAddress: network?.contracts.privateSettlement ?? "",
    fallback: network?.tokens ?? EMPTY_TOKENS,
    enabled: network ? options.enabled : false,
  });
}

// Stable empty-array identity for the null-network fallback, so the
// underlying hook's deps don't change between renders.
const EMPTY_TOKENS: never[] = [];
