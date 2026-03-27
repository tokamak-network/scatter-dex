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
   * Price compatibility: maker.sellAmount * taker.sellAmount <= maker.buyAmount * taker.buyAmount
   * Token compatibility: maker.sellToken == taker.buyToken && maker.buyToken == taker.sellToken
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

      // Price compatibility
      const compatible =
        order.sellAmount * candidate.order.sellAmount <=
        order.buyAmount * candidate.order.buyAmount;

      if (!compatible) continue;

      // Amount compatibility: each side must be able to fill
      // maker sells sellAmount, taker must buy at least that
      if (candidate.order.buyAmount > order.sellAmount) continue;
      if (order.buyAmount > candidate.order.sellAmount) continue;

      return { maker: newOrder, taker: candidate };
    }

    return null;
  }

  /**
   * Try to match all pending orders. Returns all found matches.
   */
  matchAll(): Match[] {
    const matches: Match[] = [];
    const processed = new Set<StoredOrder>();

    // Iterate all pairs
    for (const maker of this.getAllPendingOrders()) {
      if (processed.has(maker)) continue;

      const match = this.findMatch(maker);
      if (match) {
        matches.push(match);
        processed.add(match.maker);
        processed.add(match.taker);
      }
    }

    return matches;
  }

  private getAllPendingOrders(): StoredOrder[] {
    const all: StoredOrder[] = [];
    // Get from all makers
    const seen = new Set<StoredOrder>();
    // This is a simplified approach - in production would track pairs properly
    return all;
  }
}
