import { Order, SignedOrder, StoredOrder, pairKey, OrderStatus } from "../types/order.js";
import { OrderDB } from "./db.js";

export class Orderbook {
  private sells = new Map<string, StoredOrder[]>();
  private buys = new Map<string, StoredOrder[]>();
  private byMaker = new Map<string, Map<string, StoredOrder>>();
  private pendingCount = 0;
  private maxSize: number;
  private db: OrderDB | null = null;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  /** Attach a DB for persistence. Call loadFromDB() after to restore orders. */
  setDB(db: OrderDB): void {
    this.db = db;
  }

  /** Restore pending orders from DB into memory. */
  loadFromDB(): number {
    if (!this.db) return 0;
    const orders = this.db.loadPending();
    let loaded = 0;
    for (const stored of orders) {
      try {
        this.addInternal(stored);
        loaded++;
      } catch (err) {
        console.warn(`Skipped restoring order ${stored.order.maker}:${stored.order.nonce}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
    return loaded;
  }

  add(signed: SignedOrder, feeMode?: "cover_taker"): StoredOrder {
    const stored: StoredOrder = {
      ...signed,
      status: "pending",
      submittedAt: Date.now(),
      feeMode,
    };
    this.addInternal(stored);
    if (this.db) {
      try {
        this.db.save(stored);
      } catch (err) {
        // Rollback in-memory state to keep DB and memory in sync
        this.remove(stored.order);
        throw err;
      }
    }
    return stored;
  }

  private addInternal(stored: StoredOrder): void {
    if (this.pendingCount >= this.maxSize) {
      throw new Error("orderbook full");
    }
    const { order } = stored;
    const pair = pairKey(order.sellToken, order.buyToken);

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
    this.pendingCount++;

    // Determine direction: is this order selling the "first" token in the sorted pair?
    // pairKey sorts tokens, so pair = "tokenLow-tokenHigh"
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();

    if (isSellSide) {
      // This order sells the lower-sorted token → goes to sell side
      const sellList = this.sells.get(pair) || [];
      // Sorted insertion (O(N)) — price ascending by sell/buy ratio
      const idx = sellList.findIndex((existing) =>
        stored.order.sellAmount * existing.order.buyAmount <
        existing.order.sellAmount * stored.order.buyAmount
      );
      if (idx === -1) sellList.push(stored);
      else sellList.splice(idx, 0, stored);
      this.sells.set(pair, sellList);
    } else {
      // This order buys the lower-sorted token → goes to buy side
      const buyList = this.buys.get(pair) || [];
      // Sorted insertion (O(N)) — price descending by buy/sell ratio
      const idx = buyList.findIndex((existing) =>
        stored.order.buyAmount * existing.order.sellAmount >
        existing.order.buyAmount * stored.order.sellAmount
      );
      if (idx === -1) buyList.push(stored);
      else buyList.splice(idx, 0, stored);
      this.buys.set(pair, buyList);
    }
  }

  remove(order: Order): void {
    const makerKey = order.maker.toLowerCase();
    const nonceKey = order.nonce.toString();
    const stored = this.byMaker.get(makerKey)?.get(nonceKey);
    if (!stored) return;

    this.byMaker.get(makerKey)!.delete(nonceKey);
    this.pendingCount--;

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
    this.db?.updateStatus(maker, nonce, "cancelled");
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
    return this.pendingCount;
  }

  getOrderHistory(maker: string, opts: { status?: OrderStatus; limit: number; offset: number }): StoredOrder[] {
    if (!this.db) return [];
    return this.db.getOrdersByMaker(maker, opts);
  }

  getOrderByNonce(maker: string, nonce: bigint): StoredOrder | null {
    if (!this.db) return null;
    return this.db.getOrderByMakerNonce(maker, nonce);
  }

  countOrders(maker: string, status?: OrderStatus): number {
    if (!this.db) return 0;
    return this.db.countOrdersByMaker(maker, status);
  }

  /** Save an order directly to DB without adding to in-memory book (e.g. scheduled transfers). */
  persistOrder(signed: SignedOrder, status: OrderStatus, feeMode?: "cover_taker", settleTxHash?: string): void {
    if (!this.db) return;
    const stored: StoredOrder = {
      ...signed,
      status,
      submittedAt: Date.now(),
      feeMode,
      settleTxHash,
    };
    this.db.save(stored);
  }

  /** Check if a maker+nonce combination already exists (in-memory or DB). */
  hasNonce(maker: string, nonce: bigint): boolean {
    const makerKey = maker.toLowerCase();
    const nonceKey = nonce.toString();
    if (this.byMaker.get(makerKey)?.has(nonceKey)) return true;
    return this.db?.hasOrder(maker, nonce) ?? false;
  }

  /** Persist status change to DB (for settle results handled outside orderbook) */
  persistStatus(maker: string, nonce: bigint, status: OrderStatus, settleTxHash?: string): void {
    this.db?.updateStatus(maker, nonce, status, settleTxHash);
  }

  // Remove expired orders (collect first, then remove to avoid mutation during iteration)
  purgeExpired(): number {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const toRemove: Order[] = [];

    for (const [, orders] of this.byMaker) {
      for (const [, stored] of orders) {
        if (stored.status === "pending" && stored.order.expiry <= now) {
          stored.status = "expired";
          this.db?.updateStatus(stored.order.maker, stored.order.nonce, "expired");
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
