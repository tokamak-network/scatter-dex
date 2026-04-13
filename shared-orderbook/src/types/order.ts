/**
 * Re-export shared types from @scatter-dex/types.
 * Local-only types and functions (parseOrderSummary, MatchNotification) remain here.
 */
export type {
  OrderSummary,
  OrderStatus,
  StoredOrder,
  BroadcastEvent,
} from "@scatter-dex/types";

export {
  pairKey,
  isValidPair,
} from "@scatter-dex/types";

export type { ServerMatchResult as MatchResult } from "@scatter-dex/types";

export interface MatchNotification {
  matchId: string;
  maker: { id: string; relayer: string; relayerUrl: string };
  taker: { id: string; relayer: string; relayerUrl: string };
  settlingRelayer: string;
  pair: string;
  price: string;
}

import type { OrderSummary } from "@scatter-dex/types";
import { ETH_ADDRESS_RE } from "@scatter-dex/types";

// Opaque offer handle: 0x-prefixed 32-byte hex (64 hex chars). Generated
// by the maker's relayer per order; the shared orderbook never sees the
// user's pubKeyAx or order nonce.
const OFFER_HANDLE_RE = /^0x[0-9a-fA-F]{64}$/;

export function parseOrderSummary(
  raw: Record<string, unknown>,
  relayer: string,
  relayerUrl: string,
): OrderSummary {
  const sellToken = String(raw.sellToken ?? "");
  const buyToken = String(raw.buyToken ?? "");
  const sellAmount = String(raw.sellAmount ?? "");
  const buyAmount = String(raw.buyAmount ?? "");
  const minFillAmount = String(raw.minFillAmount ?? "0");
  const maxFee = Number(raw.maxFee);
  const expiry = Number(raw.expiry);
  const offerHandle = String(raw.id ?? raw.offerHandle ?? "");

  if (!OFFER_HANDLE_RE.test(offerHandle)) {
    throw new Error("invalid offer handle (expect 0x-prefixed 32-byte hex)");
  }

  if (!ETH_ADDRESS_RE.test(sellToken)) throw new Error("invalid sellToken address");
  if (!ETH_ADDRESS_RE.test(buyToken)) throw new Error("invalid buyToken address");
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) throw new Error("sellToken == buyToken");

  if (!sellAmount || BigInt(sellAmount) <= 0n) throw new Error("sellAmount must be > 0");
  if (!buyAmount || BigInt(buyAmount) <= 0n) throw new Error("buyAmount must be > 0");
  if (minFillAmount && BigInt(minFillAmount) < 0n) throw new Error("minFillAmount must be >= 0");

  if (!Number.isFinite(maxFee) || maxFee < 0) throw new Error("maxFee must be >= 0");
  if (!Number.isFinite(expiry) || expiry <= 0) throw new Error("invalid expiry");

  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now) throw new Error("order already expired");

  return {
    id: offerHandle,
    relayer: relayer.toLowerCase(),
    relayerUrl,
    sellToken: sellToken.toLowerCase(),
    buyToken: buyToken.toLowerCase(),
    sellAmount,
    buyAmount,
    minFillAmount: minFillAmount || "0",
    maxFee,
    expiry,
    createdAt: now,
  };
}
