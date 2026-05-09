/** Curated token + trading-pair whitelist for the launch lineup.
 *
 *  This is the production source of truth for what apps can offer
 *  in pickers, what relayers route, and what the marketing copy
 *  promises. It is **not** a generic ERC-20 directory — adding a
 *  token here is a deliberate product decision (compliance, liquidity,
 *  relayer support).
 *
 *  Addresses below are sentinels for the placeholder DEMO_NETWORK.
 *  Real per-network entries live in `NetworkConfig.tokens` and the
 *  per-network whitelist file is what apps should consume; this
 *  module exposes the shape + helpers, not the canonical addresses
 *  for any specific chain.
 */

import { ZERO_ADDRESS, isConfiguredAddress } from "./addresses";
import type { TokenInfo } from "./tokens";

/** Markets a token can serve as the **quote** side of (Upbit-style
 *  market tabs). Used by pickers to group pairs by quote currency
 *  and by the orderbook UI to render a "USDC market / USDT market /
 *  ETH market" tab strip. */
export type QuoteMarket = "USDC" | "USDT" | "ETH";

export interface WhitelistedToken extends TokenInfo {
  /** Display name, e.g. "Ether", "USD Coin". */
  name: string;
  /** Quote markets in which this token serves as **base** — i.e.
   *  what tabs the pair `{this}/{quote}` appears under. Empty for
   *  tokens that only ever trade as the quote side. */
  baseInMarkets?: QuoteMarket[];
  /** True for tokens we ourselves treat as a quote market tab.
   *  ETH / USDC / USDT for the launch lineup; TON is base-only. */
  isQuoteMarket?: boolean;
  /** Stable-of-stable hint — UI can render a different chip color
   *  for stables and warn on stable→stable trades. */
  category: "base" | "stable";
  /** True when launch-event 0% fee applies. Today: all four tokens. */
  launchOffer?: boolean;
}

export interface WhitelistedPair {
  /** `${baseSymbol}/${quoteSymbol}` — the canonical display string
   *  (also the key used by the shared orderbook). */
  display: string;
  base: string; // symbol
  quote: string; // symbol
  /** Featured pairs render at the top of the picker and are the
   *  default selection for new sessions. */
  featured?: boolean;
}

/** Launch-token whitelist by symbol. Apps resolve to per-network
 *  addresses via `NetworkConfig.tokens`; this map stays the
 *  symbol-keyed source of marketing + UX metadata. */
export const LAUNCH_TOKENS: Record<string, WhitelistedToken> = {
  ETH: {
    address: ZERO_ADDRESS,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
    category: "base",
    isQuoteMarket: true,
    baseInMarkets: ["USDC", "USDT"],
    launchOffer: true,
  },
  USDC: {
    address: ZERO_ADDRESS,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    isNative: false,
    category: "stable",
    isQuoteMarket: true,
    baseInMarkets: ["USDT"],
    launchOffer: true,
  },
  USDT: {
    address: ZERO_ADDRESS,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    isNative: false,
    category: "stable",
    isQuoteMarket: true,
    baseInMarkets: ["USDC"],
    launchOffer: true,
  },
  TON: {
    address: ZERO_ADDRESS,
    symbol: "TON",
    name: "Tokamak Network",
    decimals: 18,
    isNative: false,
    category: "base",
    isQuoteMarket: false,
    baseInMarkets: ["USDC", "USDT", "ETH"],
    launchOffer: true,
  },
};

/** Display string for a token symbol shown in the UI. Currently
 *  promotes TON to `Tokamak(TON)` so the project's full name is
 *  visible alongside the ticker — internal code paths (storage,
 *  ABI, RPC) keep using the bare symbol so this is purely a render
 *  helper. Add other promotions here as the launch lineup grows. */
export function formatTokenLabel(symbol: string): string {
  if (symbol === "TON") return "Tokamak(TON)";
  return symbol;
}

/** Curated launch pair list. Pair listing is explicit (not
 *  all-pairs-of-tokens) so we control which markets exist on day 1.
 *
 *  3 quote markets (USDC / USDT / ETH) × base tokens minus self-pair
 *  and minus stable/stable (USDC/USDT and USDT/USDC excluded — they
 *  are the same trade in two listings, with negligible price
 *  movement; not worth the orderbook noise). Total: 7 pairs. */
export const LAUNCH_PAIRS: readonly WhitelistedPair[] = [
  // USDC market
  { display: "ETH/USDC",  base: "ETH",  quote: "USDC", featured: true },
  { display: "TON/USDC",  base: "TON",  quote: "USDC", featured: true },
  // USDT market
  { display: "ETH/USDT",  base: "ETH",  quote: "USDT", featured: true },
  { display: "TON/USDT",  base: "TON",  quote: "USDT" },
  // ETH market
  { display: "USDC/ETH",  base: "USDC", quote: "ETH" },
  { display: "USDT/ETH",  base: "USDT", quote: "ETH" },
  { display: "TON/ETH",   base: "TON",  quote: "ETH" },
];

/** Group pairs by quote market for Upbit-style tabs. The returned
 *  map has stable insertion order matching the original pair list. */
export function pairsByMarket(
  pairs: readonly WhitelistedPair[] = LAUNCH_PAIRS,
): Record<QuoteMarket, WhitelistedPair[]> {
  const out: Record<QuoteMarket, WhitelistedPair[]> = {
    USDC: [],
    USDT: [],
    ETH: [],
  };
  for (const p of pairs) {
    if (p.quote === "USDC" || p.quote === "USDT" || p.quote === "ETH") {
      out[p.quote].push(p);
    }
  }
  return out;
}

/** Find a pair entry by its display string. */
export function findPair(
  display: string,
  pairs: readonly WhitelistedPair[] = LAUNCH_PAIRS,
): WhitelistedPair | undefined {
  return pairs.find((p) => p.display === display);
}

/** Resolve a `{symbol → on-chain address}` map from a network's
 *  configured tokens. Apps thread this through the trade form so
 *  decimals + addresses come from real per-chain entries, not the
 *  placeholder `LAUNCH_TOKENS` defaults. */
export function tokensBySymbol(
  tokens: readonly TokenInfo[],
): Record<string, TokenInfo> {
  const out: Record<string, TokenInfo> = {};
  for (const t of tokens) {
    if (isConfiguredAddress(t.address)) out[t.symbol] = t;
  }
  return out;
}
