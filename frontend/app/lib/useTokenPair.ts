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
  /** False when `tokens.length < 2`; callers render an empty state in
   *  that case rather than trying to trade against an undefined pair. */
  isReady: boolean;
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
 * Assumes `tokens` is stable (module-level memoized list). Indices are
 * clamped once at mount; if the list later shrinks we don't re-clamp.
 */
export function useTokenPair(
  tokens: TokenInfo[],
  defaultSellIdx: number = 0,
  defaultBuyIdx: number = 1,
): UseTokenPairResult {
  const isReady = tokens.length >= 2;

  // Lazy initializers so the clamp runs once at mount, not on every render.
  const [sellTokenIdx, setSellTokenIdx] = useState(() =>
    Math.min(defaultSellIdx, Math.max(tokens.length - 1, 0))
  );
  const [buyTokenIdx, setBuyTokenIdx] = useState(() =>
    Math.min(defaultBuyIdx, Math.max(tokens.length - 1, 0))
  );

  const sellToken = tokens[sellTokenIdx];
  const buyToken = tokens[buyTokenIdx];

  const swap = useCallback(() => {
    const prevSell = sellTokenIdx;
    setSellTokenIdx(buyTokenIdx);
    setBuyTokenIdx(prevSell);
  }, [sellTokenIdx, buyTokenIdx]);

  return { sellToken, buyToken, sellTokenIdx, buyTokenIdx, setSellTokenIdx, setBuyTokenIdx, swap, isReady };
}
