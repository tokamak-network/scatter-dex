import { StoredOrder, pairKey } from "../types/order.js";
import { Orderbook } from "./orderbook.js";

export interface Match {
  maker: StoredOrder;
  taker: StoredOrder;
}

export class Matcher {
  constructor(private orderbook: Orderbook) {}

  /**
   * Find a matching pair for the given order.
   * Price compatibility (BigInt cross-multiplication, matches Solidity _validateSettle):
   *   order.sellAmount * candidate.sellAmount <= order.buyAmount * candidate.buyAmount
   * Token compatibility: order.sellToken == candidate.buyToken && order.buyToken == candidate.sellToken
   */
  findMatch(newOrder: StoredOrder): Match | null {
    const { order } = newOrder;
    const pair = pairKey(order.sellToken, order.buyToken);

    // Determine which side the counterparty orders are on.
    // If this order sells the lower-sorted token, it's on the sell side,
    // so counterparty orders (selling the higher-sorted token) are on the buy side.
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();
    const candidates = isSellSide
      ? this.orderbook.getBuyOrders(pair)
      : this.orderbook.getSellOrders(pair);

    const now = BigInt(Math.floor(Date.now() / 1000));

    for (const candidate of candidates) {
      if (candidate === newOrder) continue;
      if (candidate.status !== "pending") continue;
      if (candidate.order.expiry <= now) continue;
      if (candidate.order.maker.toLowerCase() === order.maker.toLowerCase()) continue;

      // Token check
      if (candidate.order.sellToken.toLowerCase() !== order.buyToken.toLowerCase()) continue;
      if (candidate.order.buyToken.toLowerCase() !== order.sellToken.toLowerCase()) continue;

      // Price compatibility: taker offers at least maker's minimum price
      // maker.sell * taker.sell >= maker.buy * taker.buy
      const compatible =
        order.sellAmount * candidate.order.sellAmount >=
        order.buyAmount * candidate.order.buyAmount;

      if (!compatible) continue;

      // Amount compatibility: each side has enough to fill the other
      if (candidate.order.sellAmount < order.buyAmount) continue;
      if (order.sellAmount < candidate.order.buyAmount) continue;

      return { maker: newOrder, taker: candidate };
    }

    return null;
  }

}
