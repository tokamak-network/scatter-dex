"use client";

import { useMemo } from "react";
import {
  useWhitelistedTokens,
  type TokenListSource,
} from "@zkscatter/sdk/react";
import { withNativeEthAlias } from "@zkscatter/sdk";
import { getReadProvider } from "./provider";
import { getEnv } from "./config";
import { getTradableTokens, type TokenInfo } from "./tokens";

export interface UseTokenListResult {
  /** ERC-20 list with no native-ETH alias — mirrors `getTradableTokens`.
   *  This is what the trade pages feed `useTokenPair`. */
  tradable: TokenInfo[];
  /** With the native-ETH alias inserted before WETH — mirrors
   *  `getTokenList`. For pickers that offer "ETH". */
  tokens: TokenInfo[];
  /** True while the first on-chain fetch is in flight (env list shown). */
  loading: boolean;
  error: string | null;
  source: TokenListSource;
  refresh: () => void;
}

/** React token list backed by the on-chain whitelist, env list as
 *  overlay + fallback. A team deployment adds tokens via
 *  `setTokenWhitelist` and the picker updates with **no
 *  `NEXT_PUBLIC_TOKENS` edit**; a misconfigured/old chain still renders
 *  the env list rather than an empty picker.
 *
 *  Contract addresses are read via the non-throwing `getEnv` (the
 *  `requireEnv`-backed `get*Address` getters would throw during SSG when
 *  unset); the SDK hook treats unconfigured addresses as "use fallback". */
export function useTokenList(): UseTokenListResult {
  const provider = getReadProvider();
  const poolAddress = getEnv("NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS") ?? "";
  const settlementAddress =
    getEnv("NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS") ?? "";
  const wethAddress = getEnv("NEXT_PUBLIC_WETH_ADDRESS") ?? "";

  // Env list (non-native) — stable identity so it can back the SDK
  // hook's fetch deps without re-triggering every render.
  const fallback = useMemo(() => getTradableTokens(), []);

  const {
    tokens: tradable,
    loading,
    error,
    source,
    refresh,
  } = useWhitelistedTokens({
    provider,
    poolAddress,
    settlementAddress,
    fallback,
  });

  const tokens = useMemo(
    () => (wethAddress ? withNativeEthAlias(tradable, wethAddress) : tradable),
    [tradable, wethAddress],
  );

  return { tradable, tokens, loading, error, source, refresh };
}
