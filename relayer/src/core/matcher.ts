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
   * Price compatibility (BigInt cross-multiplication):
   *   order.buyAmount * candidate.buyAmount <= order.sellAmount * candidate.sellAmount
   * Token compatibility: order.sellToken == candidate.buyToken && order.buyToken == candidate.sellToken
   */
  findMatch(newOrder: StoredOrder): Match | null {
    const { order } = newOrder;
    // Look for counterparty orders that sell what this order wants to buy
    const pair = pairKey(order.buyToken, order.sellToken);
    const candidates = this.orderbook.getSellOrders(pair);

    for (const candidate of candidates) {
      if (candidate === newOrder) continue;
      if (candidate.order.maker.toLowerCase() === order.maker.toLowerCase()) continue;

      // Token check
      if (candidate.order.sellToken.toLowerCase() !== order.buyToken.toLowerCase()) continue;
      if (candidate.order.buyToken.toLowerCase() !== order.sellToken.toLowerCase()) continue;

      // Price compatibility (BigInt cross-multiplication, matches Solidity logic):
      // maker's price (sell/buy) must be <= taker's price (sell/buy) from counterparty view
      // i.e., maker.sellAmount * candidate.sellAmount <= maker.buyAmount * candidate.buyAmount
      // This ensures maker doesn't overpay relative to what candidate offers
      const compatible =
        order.buyAmount * candidate.order.buyAmount <=
        order.sellAmount * candidate.order.sellAmount;

      if (!compatible) continue;

      // Amount compatibility: each side has enough to fill the other
      if (candidate.order.sellAmount < order.buyAmount) continue;
      if (order.sellAmount < candidate.order.buyAmount) continue;

      return { maker: newOrder, taker: candidate };
    }

    return null;
  }

}
