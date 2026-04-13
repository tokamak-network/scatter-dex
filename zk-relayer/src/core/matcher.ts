import type { StoredPrivateOrder, PrivateMatch, OrderSummary, CrossRelayerMatch, MatchResult } from "../types/order.js";
import { pairKey } from "../types/order.js";
import type { PrivateOrderbook } from "./orderbook.js";
import type { RemoteOrderStore } from "./remote-orderbook.js";

// Basis-point denominator for fee-aware matching. Mirrors
// `FEE_BPS_DENOMINATOR` in the settle-verify library and the
// `10000` factor used inside settle.circom.
const FEE_BPS_DENOM = 10000n;

export class PrivateMatcher {
  private relayerAddress: string | null = null;

  constructor(
    private orderbook: PrivateOrderbook,
    private remoteOrderbook: RemoteOrderStore | null = null,
  ) {}

  /** Set this relayer's address to skip own orders in remote matching */
  setRelayerAddress(address: string): void {
    this.relayerAddress = address.toLowerCase();
  }

  /**
   * Find a matching pair for the given private order.
   * Price compatibility (BigInt cross-multiplication, matches Solidity _validateSettle):
   *   order.sellAmount * candidate.sellAmount >= order.buyAmount * candidate.buyAmount
   * Token compatibility: order.sellToken == candidate.buyToken && order.buyToken == candidate.sellToken
   */
  findMatch(newOrder: StoredPrivateOrder): PrivateMatch | null {
    const { order } = newOrder;
    const pair = pairKey(order.sellToken, order.buyToken);

    // Determine which side the counterparty orders are on
    const sellHex = "0x" + order.sellToken.toString(16).padStart(40, "0");
    const buyHex = "0x" + order.buyToken.toString(16).padStart(40, "0");
    const isSellSide = sellHex < buyHex;
    const candidates = isSellSide
      ? this.orderbook.getBuyOrders(pair)
      : this.orderbook.getSellOrders(pair);

    const now = BigInt(Math.floor(Date.now() / 1000));

    for (const candidate of candidates) {
      if (candidate === newOrder) continue;
      if (candidate.status !== "pending") continue;
      if (candidate.order.expiry <= now) continue;

      // Self-match prevention (same EdDSA pubkey)
      if (candidate.order.pubKeyAx === order.pubKeyAx &&
          candidate.order.pubKeyAy === order.pubKeyAy) continue;

      // Token check (bigint equality)
      if (candidate.order.sellToken !== order.buyToken) continue;
      if (candidate.order.buyToken !== order.sellToken) continue;

      // Price compatibility: taker offers at least maker's minimum price
      // maker.sell * taker.sell >= maker.buy * taker.buy
      const compatible =
        order.sellAmount * candidate.order.sellAmount >=
        order.buyAmount * candidate.order.buyAmount;
      if (!compatible) continue;

      // Amount compatibility including worst-case fee. The settle circuit
      // enforces
      //   maker.totalLocked + feeTokenMaker <= taker.sellAmount
      //   feeTokenMaker <= floor(taker.sellAmount * taker.maxFee / 10000)
      // With totalLocked >= maker.buyAmount (authorize 8b), a trade can only
      // close when taker.sellAmount * (10000 - taker.maxFee) >= maker.buyAmount * 10000.
      // Checking the same inequality without fees (the old version) let
      // 1:1 matches through that then failed at settle with ClaimsCapExceeded.
      if (candidate.order.sellAmount * (FEE_BPS_DENOM - candidate.order.maxFee) < order.buyAmount * FEE_BPS_DENOM) continue;
      if (order.sellAmount * (FEE_BPS_DENOM - order.maxFee) < candidate.order.buyAmount * FEE_BPS_DENOM) continue;

      return { maker: newOrder, taker: candidate };
    }

    return null;
  }

  /**
   * Try to find a match including remote orders from the shared orderbook.
   * Local matches take priority — only falls back to remote if no local match.
   */
  findMatchIncludingRemote(newOrder: StoredPrivateOrder): MatchResult | null {
    // 1. Try local match first
    const localMatch = this.findMatch(newOrder);
    if (localMatch) return localMatch;

    // 2. Try remote orders (if available)
    if (!this.remoteOrderbook) return null;

    const { order } = newOrder;
    const pair = pairKey(order.sellToken, order.buyToken);
    const sellHex = "0x" + order.sellToken.toString(16).padStart(40, "0");
    const buyHex = "0x" + order.buyToken.toString(16).padStart(40, "0");
    const isSellSide = sellHex < buyHex;

    // Remote counterparty orders (opposite side)
    const candidates = isSellSide
      ? this.remoteOrderbook.getBuyOrders(pair)
      : this.remoteOrderbook.getSellOrders(pair);

    const now = Math.floor(Date.now() / 1000);

    for (const remote of candidates) {
      if (remote.expiry <= now) continue;

      // Skip own relayer's orders (already in local orderbook)
      if (this.relayerAddress && remote.relayer.toLowerCase() === this.relayerAddress) continue;

      // Token compatibility
      const remoteSellToken = BigInt(remote.sellToken);
      const remoteBuyToken = BigInt(remote.buyToken);
      if (remoteSellToken !== order.buyToken) continue;
      if (remoteBuyToken !== order.sellToken) continue;

      // Price compatibility (same cross-multiply as local matcher)
      const remoteSellAmount = BigInt(remote.sellAmount);
      const remoteBuyAmount = BigInt(remote.buyAmount);

      const compatible =
        order.sellAmount * remoteSellAmount >=
        order.buyAmount * remoteBuyAmount;
      if (!compatible) continue;

      // Amount compatibility with worst-case fee (same bound as the local
      // matcher — see comment above). Remote orders are maker here and the
      // new local order is taker, so each side's maxFee caps the fee on
      // its own sellAmount.
      const remoteMaxFee = BigInt(remote.maxFee);
      if (remoteSellAmount * (FEE_BPS_DENOM - remoteMaxFee) < order.buyAmount * FEE_BPS_DENOM) continue;
      if (order.sellAmount * (FEE_BPS_DENOM - order.maxFee) < remoteBuyAmount * FEE_BPS_DENOM) continue;

      // Cross-relayer match found!
      // New order is taker (arrived later), remote order is maker (was there first)
      return {
        localOrder: newOrder,
        remoteOrder: remote,
        localSide: "taker" as const,
      };
    }

    return null;
  }
}
