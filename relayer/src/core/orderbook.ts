import { Order, SignedOrder, StoredOrder, pairKey } from "../types/order.js";

export class Orderbook {
  // pair => sell orders (sorted by price ascending — lowest sell price first)
  private sells = new Map<string, StoredOrder[]>();
  // pair => buy orders (sorted by price descending — highest buy price first)
  private buys = new Map<string, StoredOrder[]>();
  // maker => nonce => order (for lookup/cancel)
  private byMaker = new Map<string, Map<string, StoredOrder>>();

  add(signed: SignedOrder): StoredOrder {
    const { order } = signed;
    const pair = pairKey(order.sellToken, order.buyToken);
    const stored: StoredOrder = {
      ...signed,
      status: "pending",
      submittedAt: Date.now(),
    };

    // Dedup by maker+nonce
    const makerKey = order.maker.toLowerCase();
    const nonceKey = order.nonce.toString();
    if (!this.byMaker.has(makerKey)) {
      this.byMaker.set(makerKey, new Map());
    }
    if (this.byMaker.get(makerKey)!.has(nonceKey)) {
      throw new Error("duplicate nonce");
    }
    this.byMaker.get(makerKey)!.set(nonceKey, stored);

    // Determine direction: is this order selling the "first" token in the sorted pair?
    // pairKey sorts tokens, so pair = "tokenLow-tokenHigh"
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();

    if (isSellSide) {
      // This order sells the lower-sorted token → goes to sell side
      const sellList = this.sells.get(pair) || [];
      sellList.push(stored);
      sellList.sort((a, b) => {
        const lhs = a.order.sellAmount * b.order.buyAmount;
        const rhs = b.order.sellAmount * a.order.buyAmount;
        return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
      });
      this.sells.set(pair, sellList);
    } else {
      // This order buys the lower-sorted token → goes to buy side
      const buyList = this.buys.get(pair) || [];
      buyList.push(stored);
      buyList.sort((a, b) => {
        const lhs = a.order.buyAmount * b.order.sellAmount;
        const rhs = b.order.buyAmount * a.order.sellAmount;
        return lhs > rhs ? -1 : lhs < rhs ? 1 : 0;
      });
      this.buys.set(pair, buyList);
    }

    return stored;
  }

  remove(order: Order): void {
    const makerKey = order.maker.toLowerCase();
    const nonceKey = order.nonce.toString();
    const stored = this.byMaker.get(makerKey)?.get(nonceKey);
    if (!stored) return;

    this.byMaker.get(makerKey)!.delete(nonceKey);

    const pair = pairKey(order.sellToken, order.buyToken);
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();

    if (isSellSide) {
      const sellList = this.sells.get(pair);
      if (sellList) {
        this.sells.set(pair, sellList.filter((o) => o !== stored));
      }
    } else {
      const buyList = this.buys.get(pair);
      if (buyList) {
        this.buys.set(pair, buyList.filter((o) => o !== stored));
      }
    }
  }

  cancel(maker: string, nonce: bigint): StoredOrder | null {
    const makerKey = maker.toLowerCase();
    const nonceKey = nonce.toString();
    const stored = this.byMaker.get(makerKey)?.get(nonceKey);
    if (!stored || stored.status !== "pending") return null;

    stored.status = "cancelled";
    this.remove(stored.order);
    return stored;
  }

  getSellOrders(pair: string): StoredOrder[] {
    return (this.sells.get(pair) || []).filter((o) => o.status === "pending");
  }

  getBuyOrders(pair: string): StoredOrder[] {
    return (this.buys.get(pair) || []).filter((o) => o.status === "pending");
  }

  getOrdersByMaker(maker: string): StoredOrder[] {
    const makerKey = maker.toLowerCase();
    const orders = this.byMaker.get(makerKey);
    if (!orders) return [];
    return Array.from(orders.values());
  }

  getOrderCount(): number {
    let count = 0;
    for (const orders of this.byMaker.values()) {
      for (const o of orders.values()) {
        if (o.status === "pending") count++;
      }
    }
    return count;
  }

  // Remove expired orders (collect first, then remove to avoid mutation during iteration)
  purgeExpired(): number {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const toRemove: Order[] = [];

    for (const [, orders] of this.byMaker) {
      for (const [, stored] of orders) {
        if (stored.status === "pending" && stored.order.expiry <= now) {
          stored.status = "expired";
          toRemove.push(stored.order);
        }
      }
    }

    for (const order of toRemove) {
      this.remove(order);
    }
    return toRemove.length;
  }
}
