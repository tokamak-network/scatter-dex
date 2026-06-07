"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ethers } from "ethers";
import { fetchWhitelistedTokens } from "../core/whitelist";
import { isConfiguredAddress } from "../core/addresses";
import type { TokenInfo } from "../core/tokens";

/** Where the returned token list came from:
 *  - `loading`  — the on-chain fetch is in flight (showing `fallback`)
 *  - `onchain`  — resolved from the live pool∩settlement whitelist
 *  - `fallback` — using the env list (fetch disabled, unconfigured,
 *    errored, or the chain returned no usable tokens) */
export type TokenListSource = "loading" | "onchain" | "fallback";

export interface UseWhitelistedTokensParams {
  /** Read provider for the active chain. When null the hook stays on
   *  `fallback` (e.g. SSR / wallet not ready). */
  provider: ethers.Provider | null | undefined;
  poolAddress: string;
  settlementAddress: string;
  /** Env-derived list (`parseTokenList(NEXT_PUBLIC_TOKENS)`). Serves
   *  two roles: the **overlay** that relabels on-chain tokens and
   *  backstops reverted `symbol()`/`decimals()` reads, and the
   *  **fallback** rendered immediately and whenever the on-chain
   *  fetch can't produce a list. Pass the non-native list — the
   *  native-ETH alias (if wanted) is the caller's concern. */
  fallback: TokenInfo[];
  /** Skip the on-chain fetch and stay on `fallback`. Default true. */
  enabled?: boolean;
}

export interface UseWhitelistedTokensResult {
  tokens: TokenInfo[];
  /** True while the first (or a refresh) on-chain fetch is in flight. */
  loading: boolean;
  error: string | null;
  source: TokenListSource;
  /** Re-run the on-chain fetch (e.g. after the owner whitelists a token). */
  refresh: () => void;
}

/** Live token list backed by the on-chain whitelist, with the env list
 *  as overlay + fallback. The goal: a team deployment adds tokens via
 *  `setTokenWhitelist` and every app surfaces them with **no
 *  `NEXT_PUBLIC_TOKENS` edit** — while a missing/old chain still renders
 *  the env list instead of an empty picker.
 *
 *  Renders `fallback` first (no empty flash), then swaps to the on-chain
 *  intersection once it resolves. The caller layers `withNativeEthAlias`
 *  on `tokens` if it wants the synthetic ETH entry. */
export function useWhitelistedTokens({
  provider,
  poolAddress,
  settlementAddress,
  fallback,
  enabled = true,
}: UseWhitelistedTokensParams): UseWhitelistedTokensResult {
  const configured =
    isConfiguredAddress(poolAddress) && isConfiguredAddress(settlementAddress);
  const shouldFetch = enabled && configured && !!provider;

  const [tokens, setTokens] = useState<TokenInfo[]>(fallback);
  const [loading, setLoading] = useState(shouldFetch);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<TokenListSource>(
    shouldFetch ? "loading" : "fallback",
  );

  // Bumped on each refresh() and on unmount so a slow in-flight fetch
  // can't write stale results over a newer one (or a dead component).
  const runId = useRef(0);

  const load = useCallback(() => {
    if (!shouldFetch || !provider) {
      setTokens(fallback);
      setLoading(false);
      setError(null);
      setSource("fallback");
      return;
    }
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    setSource("loading");
    setTokens(fallback); // show env list while the fetch runs
    fetchWhitelistedTokens(provider, poolAddress, settlementAddress, {
      overlay: fallback,
    })
      .then((live) => {
        if (id !== runId.current) return;
        if (live.length > 0) {
          setTokens(live);
          setSource("onchain");
        } else {
          // Chain reachable but whitelist empty — keep the env list so
          // a dev stack without on-chain whitelisting still works.
          setTokens(fallback);
          setSource("fallback");
        }
      })
      .catch((err: unknown) => {
        if (id !== runId.current) return;
        setError(err instanceof Error ? err.message : "Failed to load tokens");
        setTokens(fallback);
        setSource("fallback");
      })
      .finally(() => {
        if (id !== runId.current) return;
        setLoading(false);
      });
  }, [shouldFetch, provider, poolAddress, settlementAddress, fallback]);

  useEffect(() => {
    load();
    return () => {
      // Invalidate any in-flight fetch on unmount / dep change.
      runId.current++;
    };
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  return { tokens, loading, error, source, refresh };
}
