/**
 * Cross-relayer types shared with the shared-orderbook server.
 *
 * Private-flow types and the `pairKey` helper were retired with the
 * tracker #29 cleanup. Authorize-flow types live in `./authorize-order.ts`
 * (which now owns `pairKey` directly), and the authorize trade-offer
 * types live alongside the service in `core/authorize-cross-relayer-matcher.ts`.
 */
export type { OrderSummary } from "@scatter-dex/types";
