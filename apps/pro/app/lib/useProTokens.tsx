"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useCuratedNetworkTokens,
  type TokenListSource,
} from "@zkscatter/sdk/react";
import { isConfiguredAddress, type TokenInfo } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "./network";

export interface UseProTokensResult {
  /** The curated trade lineup (native ETH + stables + TON), in
   *  `LAUNCH_TOKENS` order and shape, with **addresses and decimals**
   *  sourced from the on-chain Pool∩Settlement whitelist (matched by
   *  symbol; native ETH via the WETH address). Display metadata (name,
   *  market tabs, native-ness, order) stays from `LAUNCH_TOKENS`. Same
   *  shape as `DEMO_NETWORK.tokens`, so existing
   *  `.find(t => t.symbol === …)` call sites are a drop-in swap. */
  tokens: TokenInfo[];
  /** `tokens` plus a non-native WETH twin sharing the ETH address, for
   *  the deposit picker: ETH wraps ETH→WETH first, the WETH entry is a
   *  direct ERC-20 deposit. Mirrors the old module-scope `DEPOSITABLE`. */
  depositable: TokenInfo[];
  /** True while the first on-chain fetch is in flight (curated env
   *  addresses shown until it resolves). */
  loading: boolean;
  source: TokenListSource;
}

/** Fetch + derive the pro token list. Internal: run once by
 *  {@link TokensProvider}; components read the shared value via
 *  {@link useProTokens}. */
function useProTokensValue(): UseProTokensResult {
  // Addresses + decimals from the on-chain Pool∩Settlement whitelist,
  // overlaid onto the curated `DEMO_NETWORK.tokens` (display metadata,
  // order, native-ness preserved). Shared with the Pay wallet.
  const { tokens, loading, source } = useCuratedNetworkTokens(DEMO_NETWORK);

  const depositable = useMemo<TokenInfo[]>(() => {
    const eth = tokens.find((t) => t.isNative && isConfiguredAddress(t.address));
    if (!eth) return tokens;
    return [...tokens, { ...eth, symbol: "WETH", isNative: false }];
  }, [tokens]);

  // Memoize the context value so consumers don't re-render on every
  // provider render — `tokens`/`depositable` are already stable, this
  // gives the wrapper object a stable identity too.
  return useMemo(
    () => ({ tokens, depositable, loading, source }),
    [tokens, depositable, loading, source],
  );
}

const TokensCtx = createContext<UseProTokensResult | null>(null);

/** Fetches the on-chain token list **once** and shares it across the
 *  workbench + modals, so they don't each re-run the whitelist read.
 *  Mounts under `WalletProvider` (needs the wallet's read provider). */
export function TokensProvider({ children }: { children: ReactNode }) {
  const value = useProTokensValue();
  return <TokensCtx.Provider value={value}>{children}</TokensCtx.Provider>;
}

/** Read the shared pro token list. Must be used within
 *  {@link TokensProvider}. */
export function useProTokens(): UseProTokensResult {
  const ctx = useContext(TokensCtx);
  if (!ctx) {
    throw new Error("useProTokens must be used inside <TokensProvider>");
  }
  return ctx;
}
