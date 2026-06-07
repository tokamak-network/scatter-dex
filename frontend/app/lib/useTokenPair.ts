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
 * Indices are stored raw and **clamped on read**, so neither a stale
 * deep-link nor a list whose size changes can drive a dereference off
 * the end of the array. This also covers async population (the on-chain
 * whitelist fetch via `useTokenList`): the list can start empty/short
 * and grow to ≥2 once the fetch resolves — the defaults (0, 1) simply
 * resolve to a real, distinct pair the moment the list is usable, with
 * no re-seeding effect. The returned `sellTokenIdx` / `buyTokenIdx` are
 * the clamped values, so callers highlight the actually-selected option.
 */
export function useTokenPair(
  tokens: TokenInfo[],
  defaultSellIdx: number = 0,
  defaultBuyIdx: number = 1,
): UseTokenPairResult {
  const len = tokens.length;

  const [sellTokenIdx, setSellTokenIdx] = useState(defaultSellIdx);
  const [buyTokenIdx, setBuyTokenIdx] = useState(defaultBuyIdx);

  const clampedSell = clampIdx(sellTokenIdx, len);
  const clampedBuy = clampIdx(buyTokenIdx, len);

  const sellToken = tokens[clampedSell];
  const buyToken = tokens[clampedBuy];

  const swap = useCallback(() => {
    setSellTokenIdx(clampedBuy);
    setBuyTokenIdx(clampedSell);
  }, [clampedSell, clampedBuy]);

  const isReady = len >= 2 && sellToken !== undefined && buyToken !== undefined;

  return {
    sellToken,
    buyToken,
    sellTokenIdx: clampedSell,
    buyTokenIdx: clampedBuy,
    setSellTokenIdx,
    setBuyTokenIdx,
    swap,
    isReady,
  };
}
