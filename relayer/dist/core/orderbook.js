import { pairKey } from "../types/order.js";
export class Orderbook {
    sells = new Map();
    buys = new Map();
    byMaker = new Map();
    pendingCount = 0;
    maxSize;
    constructor(maxSize = 10_000) {
        this.maxSize = maxSize;
    }
    add(signed) {
        if (this.pendingCount >= this.maxSize) {
            throw new Error("orderbook full");
        }
        const { order } = signed;
        const pair = pairKey(order.sellToken, order.buyToken);
        const stored = {
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
        if (this.byMaker.get(makerKey).has(nonceKey)) {
            throw new Error("duplicate nonce");
        }
        this.byMaker.get(makerKey).set(nonceKey, stored);
        this.pendingCount++;
        // Determine direction: is this order selling the "first" token in the sorted pair?
        // pairKey sorts tokens, so pair = "tokenLow-tokenHigh"
        const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();
        if (isSellSide) {
            // This order sells the lower-sorted token → goes to sell side
            const sellList = this.sells.get(pair) || [];
            // Sorted insertion (O(N)) — price ascending by sell/buy ratio
            const idx = sellList.findIndex((existing) => stored.order.sellAmount * existing.order.buyAmount <
                existing.order.sellAmount * stored.order.buyAmount);
            if (idx === -1)
                sellList.push(stored);
            else
                sellList.splice(idx, 0, stored);
            this.sells.set(pair, sellList);
        }
        else {
            // This order buys the lower-sorted token → goes to buy side
            const buyList = this.buys.get(pair) || [];
            // Sorted insertion (O(N)) — price descending by buy/sell ratio
            const idx = buyList.findIndex((existing) => stored.order.buyAmount * existing.order.sellAmount >
                existing.order.buyAmount * stored.order.sellAmount);
            if (idx === -1)
                buyList.push(stored);
            else
                buyList.splice(idx, 0, stored);
            this.buys.set(pair, buyList);
        }
        return stored;
    }
    remove(order) {
        const makerKey = order.maker.toLowerCase();
        const nonceKey = order.nonce.toString();
        const stored = this.byMaker.get(makerKey)?.get(nonceKey);
        if (!stored)
            return;
        this.byMaker.get(makerKey).delete(nonceKey);
        this.pendingCount--;
        const pair = pairKey(order.sellToken, order.buyToken);
        const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();
        if (isSellSide) {
            const sellList = this.sells.get(pair);
            if (sellList) {
                this.sells.set(pair, sellList.filter((o) => o !== stored));
            }
        }
        else {
            const buyList = this.buys.get(pair);
            if (buyList) {
                this.buys.set(pair, buyList.filter((o) => o !== stored));
            }
        }
    }
    cancel(maker, nonce) {
        const makerKey = maker.toLowerCase();
        const nonceKey = nonce.toString();
        const stored = this.byMaker.get(makerKey)?.get(nonceKey);
        if (!stored || stored.status !== "pending")
            return null;
        stored.status = "cancelled";
        this.remove(stored.order);
        return stored;
    }
    getSellOrders(pair) {
        return (this.sells.get(pair) || []).filter((o) => o.status === "pending");
    }
    getBuyOrders(pair) {
        return (this.buys.get(pair) || []).filter((o) => o.status === "pending");
    }
    getOrdersByMaker(maker) {
        const makerKey = maker.toLowerCase();
        const orders = this.byMaker.get(makerKey);
        if (!orders)
            return [];
        return Array.from(orders.values());
    }
    getOrderCount() {
        return this.pendingCount;
    }
    // Remove expired orders (collect first, then remove to avoid mutation during iteration)
    purgeExpired() {
        const now = BigInt(Math.floor(Date.now() / 1000));
        const toRemove = [];
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
