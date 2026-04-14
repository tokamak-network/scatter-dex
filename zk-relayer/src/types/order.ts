/**
 * Cross-relayer types shared with the shared-orderbook server.
 *
 * The previous Private-flow types (`PrivateOrder`, `StoredPrivateOrder`,
 * `PrivateMatch`, `parsePrivateOrder`, `serializePrivateOrder`, `pairKey`,
 * `CrossRelayerMatch`, `MatchResult`, `isCrossRelayerMatch`,
 * `TradeOfferRequest`, `TradeOfferResponse`) were retired with the
 * tracker #29 cleanup. Authorize-flow types live in `./authorize-order.ts`
 * and the authorize trade-offer types live alongside the service in
 * `core/authorize-cross-relayer-matcher.ts`.
 */
export type { OrderSummary } from "@scatter-dex/types";

/**
 * Sorted "lo-hi" hex address pair used as a stable key for an unordered
 * (sellToken, buyToken) pair. Kept here because it's address-arithmetic,
 * not Private-flow specific — `authorize-order.ts` re-exports it.
 */
export function pairKey(tokenA: bigint, tokenB: bigint): string {
  const a = "0x" + tokenA.toString(16).padStart(40, "0");
  const b = "0x" + tokenB.toString(16).padStart(40, "0");
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}-${hi}`;
}
