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

import { ethers } from "ethers";
import { ZERO_ADDRESS, isConfiguredAddress } from "./addresses";
import { COMMITMENT_POOL_ABI, PRIVATE_SETTLEMENT_ABI, ERC20_ABI } from "./contracts";
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

/** Options for {@link fetchWhitelistedTokens}. */
export interface FetchWhitelistedTokensOptions {
  /** Metadata/label overlay — typically `parseTokenList(NEXT_PUBLIC_TOKENS)`.
   *  When an on-chain token's address matches an overlay entry, the
   *  overlay's `symbol` wins (a deliberate label override, e.g. relabel
   *  a deploy's mock "TestUSDC" to "USDC" without redeploying). Decimals
   *  always come from the chain — see below. Overlay also acts as a
   *  symbol/decimals fallback when a token's `symbol()`/`decimals()`
   *  call reverts (non-standard ERC-20). Addresses are matched
   *  case-insensitively. */
  overlay?: readonly TokenInfo[];
}

/** Build the live token list from on-chain whitelist state, so a team
 *  deployment can add tokens via `setTokenWhitelist` and have every app
 *  pick them up with **no `NEXT_PUBLIC_TOKENS` edit**.
 *
 *  A token must be whitelisted on **both** the CommitmentPool (deposit)
 *  and the PrivateSettlement (settle/claim) to be usable end-to-end, so
 *  the result is the **intersection** of the two contracts' lists.
 *
 *  The on-chain order is NOT stable — `EnumerableSet` removal does a
 *  swap-and-pop, so a token list can reshuffle when any token is
 *  removed. The result is therefore sorted deterministically: overlay
 *  tokens first in overlay (`NEXT_PUBLIC_TOKENS` / launch) order so the
 *  curated lineup keeps its intended ordering, then any on-chain-only
 *  tokens by symbol then address. This keeps picker order — and thus
 *  the default trading pair — stable across reads.
 *
 *  Each token's `symbol` and `decimals` are read on-chain. `decimals` is
 *  always taken from the chain (so non-standard tokens like 27-decimals
 *  WTON are exact); the optional {@link FetchWhitelistedTokensOptions.overlay}
 *  can override `symbol` (label) and provides a fallback if a read
 *  reverts. Tokens whose symbol/decimals can be resolved from neither
 *  the chain nor the overlay are dropped (an unreadable ERC-20 is
 *  unusable in a picker).
 *
 *  Returns `[]` (not a throw) when either address is unconfigured —
 *  callers treat that as "fall back to the env list". A getter revert
 *  (e.g. a contract predating the whitelist getter) **throws** so the
 *  caller's catch can fall back rather than silently showing nothing.
 *
 *  The native-ETH alias is intentionally *not* applied here; callers
 *  layer it via `withNativeEthAlias(list, wethAddress)`. */
export async function fetchWhitelistedTokens(
  provider: ethers.Provider,
  poolAddress: string,
  settlementAddress: string,
  options: FetchWhitelistedTokensOptions = {},
): Promise<TokenInfo[]> {
  if (
    !isConfiguredAddress(poolAddress) ||
    !isConfiguredAddress(settlementAddress)
  ) {
    return [];
  }

  const pool = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, provider);
  const settlement = new ethers.Contract(
    settlementAddress,
    PRIVATE_SETTLEMENT_ABI,
    provider,
  );
  const [poolList, settlementList] = await Promise.all([
    pool.getWhitelistedTokens() as Promise<string[]>,
    settlement.getWhitelistedTokens() as Promise<string[]>,
  ]);

  const settlementSet = new Set(settlementList.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const intersection: string[] = [];
  for (const addr of poolList) {
    const key = addr.toLowerCase();
    if (settlementSet.has(key) && !seen.has(key)) {
      seen.add(key);
      intersection.push(addr);
    }
  }

  // One pass over the overlay gives both the per-token metadata (for
  // symbol override / read-revert fallback) and the order index (for
  // the deterministic sort).
  const overlayMap = buildOverlayMap(options.overlay);
  const resolved = (
    await Promise.all(
      intersection.map((address) =>
        buildTokenInfo(provider, address, overlayMap.get(address.toLowerCase())?.token),
      ),
    )
  ).filter((t): t is TokenInfo => t !== null);

  return sortTokens(resolved, overlayMap);
}

/** Lowercase-address → `{ token, index }` from the overlay, where
 *  `index` is the token's position in the overlay (its curated order). */
function buildOverlayMap(
  overlay?: readonly TokenInfo[],
): Map<string, { token: TokenInfo; index: number }> {
  const map = new Map<string, { token: TokenInfo; index: number }>();
  overlay?.forEach((token, index) => {
    if (token.address) map.set(token.address.toLowerCase(), { token, index });
  });
  return map;
}

/** Deterministic order independent of the on-chain set's ordering:
 *  overlay tokens first in overlay order, then the rest by symbol then
 *  address (both case-insensitive). */
function sortTokens(
  tokens: TokenInfo[],
  overlayMap: Map<string, { token: TokenInfo; index: number }>,
): TokenInfo[] {
  return tokens.slice().sort((a, b) => {
    const ai = overlayMap.get(a.address.toLowerCase())?.index;
    const bi = overlayMap.get(b.address.toLowerCase())?.index;
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1; // overlay tokens sort ahead of extras
    if (bi !== undefined) return 1;
    return (
      a.symbol.localeCompare(b.symbol) ||
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );
  });
}

/** Resolve one whitelisted address into a `TokenInfo`, reading
 *  `symbol()`/`decimals()` on-chain with the overlay as override
 *  (symbol) and fallback (symbol + decimals). Returns `null` when
 *  neither source yields a usable symbol+decimals. */
async function buildTokenInfo(
  provider: ethers.Provider,
  address: string,
  overlay: TokenInfo | undefined,
): Promise<TokenInfo | null> {
  const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
  const [symbolRes, decimalsRes] = await Promise.allSettled([
    erc20.symbol() as Promise<string>,
    erc20.decimals() as Promise<bigint | number>,
  ]);

  const onChainSymbol =
    symbolRes.status === "fulfilled" ? symbolRes.value : undefined;
  const onChainDecimals =
    decimalsRes.status === "fulfilled" ? Number(decimalsRes.value) : undefined;

  // Overlay symbol is a deliberate label override; otherwise use the
  // on-chain symbol. Decimals always prefer the chain (exact for
  // non-standard tokens); overlay only backstops a reverted read.
  const symbol = overlay?.symbol ?? onChainSymbol;
  const decimals = onChainDecimals ?? overlay?.decimals;

  if (
    symbol === undefined ||
    symbol.length === 0 ||
    decimals === undefined ||
    !Number.isInteger(decimals) ||
    decimals < 0
  ) {
    return null;
  }
  return { address, symbol, decimals, isNative: false };
}
