"use client";

import { useEffect, useState } from "react";

/** CoinGecko spot price by symbol — close to a Uniswap mid-quote
 *  for typical retail size. The original UI labelled this "vs
 *  Uniswap quote", but no Uniswap call was actually made; spot
 *  price is what we can honestly source without on-chain quoter
 *  calls (which would require real mainnet token addresses, not
 *  the DEMO_NETWORK sentinels).
 *
 *  When the protocol launches against real mainnet token addresses
 *  we should swap this for an on-chain `Quoter.quoteExactInputSingle`
 *  call so the comparison reflects actual AMM execution including
 *  slippage curves. */

interface ReferencePrice {
  /** USD price per 1 unit of the requested token. Null while
   *  loading, on fetch failure, or when the symbol isn't covered
   *  by the upstream price feed. */
  usd: number | null;
  /** True while the first fetch is in flight. */
  loading: boolean;
  /** Last fetch error, surfaced for debugging. Cleared on a
   *  successful refetch. */
  error: string | null;
}

const COINGECKO_IDS: Record<string, string> = {
  ETH: "ethereum",
  WETH: "weth",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  WBTC: "wrapped-bitcoin",
  BTC: "bitcoin",
  TON: "the-open-network",
};

/** Fetch USD spot price for the given token symbol from CoinGecko's
 *  free public API. Refetches on `symbol` change. Tokens not in
 *  the lookup table return `usd: null` without hitting the
 *  network — calling code should treat that as "no reference". */
export function useReferencePrice(symbol: string | null | undefined): ReferencePrice {
  const [state, setState] = useState<ReferencePrice>({
    usd: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!symbol) {
      setState({ usd: null, loading: false, error: null });
      return;
    }
    const id = COINGECKO_IDS[symbol.toUpperCase()];
    if (!id) {
      setState({ usd: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    void (async () => {
      try {
        // Cap the wait — CoinGecko free tier occasionally hangs on
        // throttled IPs. Five seconds is the longest we'd block the
        // workbench from showing *any* reference state.
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
        const data = (await res.json()) as Record<string, { usd?: number }>;
        if (cancelled) return;
        const usd = data[id]?.usd;
        if (typeof usd !== "number" || !Number.isFinite(usd)) {
          throw new Error("price field missing or invalid");
        }
        setState({ usd, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          usd: null,
          loading: false,
          error: err instanceof Error ? err.message : "fetch failed",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return state;
}
