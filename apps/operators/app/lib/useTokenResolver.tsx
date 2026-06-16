"use client";

/**
 * Shared token symbol+decimals resolver for operator pages that render
 * ERC-20 amounts (orders, leaderboard, …). Prefers the **on-chain token
 * whitelist** (real `symbol()`/`decimals()`, #928/#929) so amounts for
 * tokens absent from `NEXT_PUBLIC_TOKENS` still render decimals-aware
 * instead of as raw wei against a truncated address; the env registry
 * (`tokenInfo`) is the immediate-render fallback.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TokenInfo as WhitelistToken } from "@zkscatter/sdk/core";
import { useWallet, useWhitelistedTokens } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "./network";
import { tokenInfo, type TokenInfo } from "./tokenRegistry";

export type TokenResolver = (addr: string | null | undefined) => TokenInfo;

// Stable empty fallback so the hook passes the same array reference on
// every render. `useWhitelistedTokens` already reads `fallback` through a
// ref so identity doesn't drive its fetch, but a module constant keeps a
// fresh `[]` from being allocated per render regardless.
const EMPTY_FALLBACK: WhitelistToken[] = [];

/** Build a resolver backed by the on-chain whitelist with the env
 *  registry as fallback. Self-contained — reads the active read provider
 *  from `useWallet`, so callers just `const resolve = useTokenResolver()`. */
export function useTokenResolver(): TokenResolver {
  const { readProvider } = useWallet();
  const { tokens } = useWhitelistedTokens({
    provider: readProvider,
    poolAddress: DEMO_NETWORK.contracts.commitmentPool,
    settlementAddress: DEMO_NETWORK.contracts.privateSettlement,
    fallback: EMPTY_FALLBACK,
  });
  return useMemo<TokenResolver>(() => {
    const byAddr = new Map(
      tokens.map((t) => [t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals }]),
    );
    return (addr) => (addr ? byAddr.get(addr.toLowerCase()) ?? tokenInfo(addr) : tokenInfo(addr));
  }, [tokens]);
}

// Default to the env-only resolver so a component rendered outside a
// provider (or before the on-chain fetch resolves) still formats amounts.
const TokenResolverContext = createContext<TokenResolver>(tokenInfo);

/** Publish a resolver to the subtree so nested cells (drawer, recipient
 *  / fee tables) resolve tokens without prop-drilling. */
export function TokenResolverProvider({
  value,
  children,
}: {
  value: TokenResolver;
  children: ReactNode;
}) {
  return (
    <TokenResolverContext.Provider value={value}>{children}</TokenResolverContext.Provider>
  );
}

/** Read the resolver published by the nearest `TokenResolverProvider`. */
export function useResolveToken(): TokenResolver {
  return useContext(TokenResolverContext);
}
