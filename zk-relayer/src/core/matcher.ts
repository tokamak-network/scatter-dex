import type { StoredPrivateOrder, PrivateMatch, OrderSummary, CrossRelayerMatch, MatchResult } from "../types/order.js";
import { pairKey } from "../types/order.js";
import type { PrivateOrderbook } from "./orderbook.js";
import type { RemoteOrderStore } from "./remote-orderbook.js";

// Basis-point denominator shared with `SettleVerifyLib.FEE_BPS_DENOMINATOR`
// and the `10000` factor inside settle.circom.
export const FEE_BPS_DENOMINATOR = 10_000n;

/**
 * Can a match between two signed orders survive settle? Derived from
 * settle.circom §8b+§8c and each side's `maxFee` cap:
 *   totalLocked >= counterpartyBuy               (8b)
 *   totalLocked + feeToken <= sellAmount         (8c)
 *   feeToken   <= sellAmount * maxFee / 10000    (authorize cap)
 * Combining yields sellAmount * (10000 − maxFee) >= counterpartyBuy * 10000.
 * The check never divides — keeps it exact in BigInt.
 */
export function isSettleFeeCovered(sellAmount: bigint, maxFee: bigint, counterpartyBuy: bigint): boolean {
  return sellAmount * (FEE_BPS_DENOMINATOR - maxFee) >= counterpartyBuy * FEE_BPS_DENOMINATOR;
}

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

      // Amount compatibility with the signed maxFee as worst-case fee bound.
      if (!isSettleFeeCovered(candidate.order.sellAmount, candidate.order.maxFee, order.buyAmount)) continue;
      if (!isSettleFeeCovered(order.sellAmount, order.maxFee, candidate.order.buyAmount)) continue;

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

      // Amount compatibility with worst-case fee — same shape as the local
      // matcher, but `remote.maxFee` arrives as a string on OrderSummary.
      const remoteMaxFee = BigInt(remote.maxFee);
      if (!isSettleFeeCovered(remoteSellAmount, remoteMaxFee, order.buyAmount)) continue;
      if (!isSettleFeeCovered(order.sellAmount, order.maxFee, remoteBuyAmount)) continue;

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
