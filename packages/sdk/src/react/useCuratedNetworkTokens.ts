"use client";

import { useMemo } from "react";
import {
  useWhitelistedTokens,
  type TokenListSource,
} from "./useWhitelistedTokens";
import { useWallet } from "./wallet";
import {
  curatedErc20View,
  overlayOnchainTokens,
  type TokenInfo,
} from "../core/tokens";
import type { NetworkConfig } from "../core/network";

export interface UseCuratedNetworkTokensResult {
  /** The curated `network.tokens` list (order + display metadata
   *  preserved) with **addresses and decimals** overlaid from the
   *  on-chain Pool∩Settlement whitelist. Same shape as
   *  `network.tokens`, so existing `.find(t => t.symbol === …)` /
   *  `.map` call sites are a drop-in swap. */
  tokens: TokenInfo[];
  /** True while the first on-chain fetch is in flight (the curated env
   *  addresses are shown until it resolves). */
  loading: boolean;
  source: TokenListSource;
}

/** Curated token list with addresses + decimals sourced from the
 *  on-chain whitelist instead of `NEXT_PUBLIC_*` env. The goal: a team
 *  deployment adds tokens via `setTokenWhitelist` and the wallet /
 *  balance surfaces resolve them — with the right decimals — without an
 *  env edit, while keeping `LAUNCH_TOKENS`' display metadata (name,
 *  markets, order, native-ness).
 *
 *  Native ETH resolves via the WETH address (on-chain it is "WETH",
 *  sharing the address); other tokens match by symbol. Tokens absent
 *  from the whitelist keep their curated (possibly zero) address and
 *  render as "not configured" at the call site.
 *
 *  Shared by the Pay wallet and Pro workbench. Must be used within the
 *  SDK `<WalletProvider>` (every app already is). `network` is nullable
 *  so a caller that hasn't resolved the active network yet gets a
 *  graceful curated/empty list with the fetch disabled. */
export function useCuratedNetworkTokens(
  network: NetworkConfig | null | undefined,
): UseCuratedNetworkTokensResult {
  const { readProvider } = useWallet();
  const weth = network?.contracts.weth ?? "";

  // ERC-20 view of the curated list (native ETH → WETH) used as the
  // on-chain overlay (symbol/decimals by address) and the fallback.
  const overlay = useMemo<TokenInfo[]>(
    () => curatedErc20View(network?.tokens ?? []),
    [network?.tokens],
  );

  const { tokens: onchain, loading, source } = useWhitelistedTokens({
    provider: readProvider,
    poolAddress: network?.contracts.commitmentPool ?? "",
    settlementAddress: network?.contracts.privateSettlement ?? "",
    fallback: overlay,
    enabled: !!network,
  });

  const tokens = useMemo<TokenInfo[]>(
    () => overlayOnchainTokens(network?.tokens ?? [], onchain, weth),
    [onchain, weth, network?.tokens],
  );

  // `tokens` is already memoized; `loading`/`source` are primitives.
  // Consumers destructure immediately, so a wrapper memo buys nothing.
  return { tokens, loading, source };
}
