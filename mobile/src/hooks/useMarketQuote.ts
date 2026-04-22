/**
 * useMarketQuote — single source of truth for the DEX quote shown in
 * `MarketQuoteCard` and used by the submit path in `TradeScreen`.
 *
 * Before this hook existed, `MarketQuoteCard` ran its own debounced
 * `getBestSwapRoute` useEffect for preview and `TradeScreen.handlePlaceOrder`
 * issued a second identical call on submit — paying the 1inch /
 * Uniswap round-trip twice and risking a quote skew between the two
 * calls. Lifting the fetch here lets the card render from the same
 * state the submit path consumes.
 *
 * The returned `params` object captures the exact inputs the stored
 * `route` was built against; the submit path compares it with its
 * current inputs via `paramsMatch` before reusing — any drift falls
 * back to a fresh fetch so we never execute on stale calldata.
 */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SLIPPAGE_BPS, getBestSwapRoute, SwapRoute } from '../lib/dex-aggregator';
import { friendlyError } from '../lib/error-messages';

const DEBOUNCE_MS = 500;

export interface MarketQuoteParams {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;     // post-fee amount fed into the router
  minReceive: bigint;
  recipient: string;      // settlement contract — baked into calldata
  /** Slippage tolerance in bps. Required at this layer so the hook and
   *  submit path agree on a concrete value: the aggregator silently
   *  defaults omitted slippage to `DEFAULT_SLIPPAGE_BPS`, and treating
   *  `undefined` as `0` here would accept a cached route built against
   *  a different slippage setting as a match. */
  slippageBps: number;
}

export interface MarketQuoteState {
  route: SwapRoute | null;
  loading: boolean;
  error: string | null;
  /** Params the cached `route` was built against. `null` until first
   *  successful fetch, mirrors `route`. */
  params: MarketQuoteParams | null;
}

/** Does the currently-cached route match the inputs the caller is
 *  about to submit with? Compare BigInts with `===` — they're value
 *  types in JS, but still typed-checked for safety. */
export function paramsMatch(a: MarketQuoteParams | null, b: MarketQuoteParams | null): boolean {
  if (!a || !b) return false;
  return (
    a.chainId === b.chainId
    && a.sellToken === b.sellToken
    && a.buyToken === b.buyToken
    && a.sellAmount === b.sellAmount
    && a.minReceive === b.minReceive
    && a.recipient === b.recipient
    && a.slippageBps === b.slippageBps
  );
}

/**
 * Debounced quote fetcher. Pass `enabled=false` (e.g. tradeType !== 'market')
 * to short-circuit the effect and clear any stale state.
 *
 * `params === null` means the caller's inputs aren't yet valid for a
 * quote (empty amount, missing token, etc.) — the hook resets and
 * doesn't fire.
 */
export function useMarketQuote(
  params: MarketQuoteParams | null,
  enabled: boolean,
): MarketQuoteState {
  const [state, setState] = useState<MarketQuoteState>({
    route: null, loading: false, error: null, params: null,
  });

  // Stable signature — avoid refiring the effect on fresh-but-equivalent
  // object identities (TradeScreen rebuilds `params` on every render).
  const sig = useMemo(() => {
    if (!params) return null;
    return `${params.chainId}|${params.sellToken}|${params.buyToken}|${params.sellAmount}|${params.minReceive}|${params.recipient}|${params.slippageBps}`;
  }, [params]);

  useEffect(() => {
    if (!enabled || !params || !sig) {
      setState({ route: null, loading: false, error: null, params: null });
      return;
    }

    // Two-layer cancel: `AbortController` kills any in-flight fetch
    // (stacked fetches on fast typing would otherwise race), and the
    // `cancelled` flag keeps setState out of an unmounted/stale render.
    const controller = new AbortController();
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const timer = setTimeout(async () => {
      try {
        const route = await getBestSwapRoute({
          ...params,
          signal: controller.signal,
        });
        if (cancelled) return;
        setState({ route, loading: false, error: null, params });
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // Chains without a deployed Uniswap router (plain local anvil,
        // chain 31337) can never produce a market quote. That's not a
        // bug to flag every keystroke — silently clear and let the
        // Market tab surface the config gap once at submit time.
        const msg = (err as any)?.message ?? '';
        if (/Uniswap V3 router not configured/i.test(msg)) {
          setState({ route: null, loading: false, error: null, params: null });
          return;
        }
        // Keep the previously-cached `route`/`params` on transient
        // failure — otherwise a flaky 1inch tick would nuke a perfectly
        // good quote and force the submit path to refetch. The UI still
        // surfaces the error, so the user knows the preview is stale.
        setState((prev) => ({
          route: prev.route,
          loading: false,
          error: friendlyError(err),
          params: prev.params,
        }));
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // `sig` captures every field of `params`, so depending on it (rather
    // than `params` itself) keeps the effect stable across renders that
    // produce a fresh-but-equivalent `params` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, enabled]);

  return state;
}
