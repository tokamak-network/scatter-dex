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

    // Add to sell side
    const sellList = this.sells.get(pair) || [];
    sellList.push(stored);
    // Sort by price (sellAmount/buyAmount) ascending
    sellList.sort((a, b) => {
      const priceA = Number(a.order.sellAmount) / Number(a.order.buyAmount);
      const priceB = Number(b.order.sellAmount) / Number(b.order.buyAmount);
      return priceA - priceB;
    });
    this.sells.set(pair, sellList);

    // Also add to buy side (from the counterparty's perspective)
    const reversePair = pairKey(order.buyToken, order.sellToken);
    const buyList = this.buys.get(reversePair) || [];
    buyList.push(stored);
    // Sort by buy price descending (highest price = most willing buyer)
    buyList.sort((a, b) => {
      const priceA = Number(a.order.buyAmount) / Number(a.order.sellAmount);
      const priceB = Number(b.order.buyAmount) / Number(b.order.sellAmount);
      return priceB - priceA;
    });
    this.buys.set(reversePair, buyList);

    return stored;
  }

  remove(order: Order): void {
    const makerKey = order.maker.toLowerCase();
    const nonceKey = order.nonce.toString();
    const stored = this.byMaker.get(makerKey)?.get(nonceKey);
    if (!stored) return;

    this.byMaker.get(makerKey)!.delete(nonceKey);

    // Remove from sell list
    const pair = pairKey(order.sellToken, order.buyToken);
    const sellList = this.sells.get(pair);
    if (sellList) {
      this.sells.set(pair, sellList.filter((o) => o !== stored));
    }

    // Remove from buy list
    const reversePair = pairKey(order.buyToken, order.sellToken);
    const buyList = this.buys.get(reversePair);
    if (buyList) {
      this.buys.set(reversePair, buyList.filter((o) => o !== stored));
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
