"use client";

import { useCallback, useState } from "react";
import type { TokenInfo } from "./tokens";

export interface UseTokenPairResult {
  sellToken: TokenInfo | undefined;
  buyToken: TokenInfo | undefined;
  sellTokenIdx: number;
  buyTokenIdx: number;
  setSellTokenIdx: (i: number) => void;
  setBuyTokenIdx: (i: number) => void;
  /** Swap sell ↔ buy in a single render. */
  swap: () => void;
  /** True when the pair is in a usable state: `tokens.length >= 2`
   *  AND both resolved tokens are defined. Callers short-circuit to
   *  an empty state when false rather than trying to trade against
   *  an undefined pair. */
  isReady: boolean;
}

// Clamp an arbitrary integer index into the tokens array bounds. When
// tokens is empty the return is 0 — safe because callers gate on
// `isReady` before dereferencing.
function clampIdx(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}

/**
 * Shared state for the two-token trade selectors on `/trade/private-order`
 * and `/trade/dex-trade`. Centralizes the crash guard: when the configured
 * `NEXT_PUBLIC_TOKENS` list has fewer than two entries, `tokens[1]` is
 * `undefined` and the downstream price / estimate effects fail —
 * `isReady` lets the page short-circuit to an empty state before any of
 * that runs.
 *
 * The hook is deliberately unaware of deep-link prefill (?sell=, ?buy=)
 * and of same-pair avoidance rules — those stay in the page so each one
 * can encode its own policy (e.g. private-order allows same-token
 * "scatter" mode while dex-trade rejects it).
 *
 * All index writes (initial defaults and public setters) are clamped to
 * `[0, tokens.length - 1]`, so a misconfigured env or a stale deep-link
 * can't drive state off the end of the array.
 *
 * Assumes `tokens` is stable (module-level memoized list). Indices are
 * NOT re-clamped if the list later shrinks.
 */
export function useTokenPair(
  tokens: TokenInfo[],
  defaultSellIdx: number = 0,
  defaultBuyIdx: number = 1,
): UseTokenPairResult {
  const len = tokens.length;

  const [sellTokenIdx, setSellTokenIdxRaw] = useState(() => clampIdx(defaultSellIdx, len));
  const [buyTokenIdx, setBuyTokenIdxRaw] = useState(() => clampIdx(defaultBuyIdx, len));

  const setSellTokenIdx = useCallback((i: number) => setSellTokenIdxRaw(clampIdx(i, len)), [len]);
  const setBuyTokenIdx = useCallback((i: number) => setBuyTokenIdxRaw(clampIdx(i, len)), [len]);

  const sellToken = tokens[sellTokenIdx];
  const buyToken = tokens[buyTokenIdx];

  const swap = useCallback(() => {
    const prevSell = sellTokenIdx;
    setSellTokenIdxRaw(buyTokenIdx);
    setBuyTokenIdxRaw(prevSell);
  }, [sellTokenIdx, buyTokenIdx]);

  const isReady = len >= 2 && sellToken !== undefined && buyToken !== undefined;

  return { sellToken, buyToken, sellTokenIdx, buyTokenIdx, setSellTokenIdx, setBuyTokenIdx, swap, isReady };
}
