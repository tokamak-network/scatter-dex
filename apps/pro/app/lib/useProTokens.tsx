"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useWallet,
  useWhitelistedTokens,
  type TokenListSource,
} from "@zkscatter/sdk/react";
import { eqAddr, isConfiguredAddress, type TokenInfo } from "@zkscatter/sdk";
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
  const { readProvider } = useWallet();
  const weth = DEMO_NETWORK.contracts.weth;

  // ERC-20 view of the curated list (native ETH → WETH) used as the
  // on-chain overlay (symbol/decimals by address) and fallback. Keeping
  // ETH out of the overlay avoids mislabelling the on-chain WETH (they
  // share an address) as "ETH".
  const overlay = useMemo<TokenInfo[]>(
    () =>
      DEMO_NETWORK.tokens.map((t) =>
        t.isNative ? { ...t, symbol: "WETH", isNative: false } : t,
      ),
    [],
  );

  const { tokens: onchain, loading, source } = useWhitelistedTokens({
    provider: readProvider,
    poolAddress: DEMO_NETWORK.contracts.commitmentPool,
    settlementAddress: DEMO_NETWORK.contracts.privateSettlement,
    fallback: overlay,
  });

  // Overlay on-chain address + decimals onto the curated list. Native
  // ETH takes the WETH entry (matched by address since on-chain it's
  // "WETH"); the rest match by symbol. Display metadata (name, markets,
  // order) is preserved via the `...t` spread. Tokens absent from the
  // whitelist keep their curated (possibly zero) address and render as
  // "not deployed" at the call sites.
  const tokens = useMemo<TokenInfo[]>(() => {
    const bySymbol = new Map(onchain.map((t) => [t.symbol.toUpperCase(), t]));
    const wethEntry = onchain.find((t) => eqAddr(t.address, weth));
    return DEMO_NETWORK.tokens.map((t) => {
      if (t.isNative) {
        return wethEntry
          ? { ...t, address: wethEntry.address, decimals: wethEntry.decimals }
          : t;
      }
      const m = bySymbol.get(t.symbol.toUpperCase());
      return m ? { ...t, address: m.address, decimals: m.decimals } : t;
    });
  }, [onchain, weth]);

  const depositable = useMemo<TokenInfo[]>(() => {
    const eth = tokens.find((t) => t.isNative && isConfiguredAddress(t.address));
    if (!eth) return tokens;
    return [...tokens, { ...eth, symbol: "WETH", isNative: false }];
  }, [tokens]);

  return { tokens, depositable, loading, source };
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
