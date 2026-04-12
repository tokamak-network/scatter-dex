import type { PrivateOrder, StoredPrivateOrder, PrivateOrderStatus } from "../types/order.js";
import { pairKey } from "../types/order.js";
import type { PrivateOrderDB } from "./db.js";

export class PrivateOrderbook {
  private sells = new Map<string, StoredPrivateOrder[]>();
  private buys = new Map<string, StoredPrivateOrder[]>();
  // Keyed by pubKeyAx → nonce → order
  private byPubKey = new Map<string, Map<string, StoredPrivateOrder>>();
  private pendingCount = 0;
  private maxSize: number;
  private db: PrivateOrderDB | null = null;

  get pendingOrderCount(): number { return this.pendingCount; }

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  setDB(db: PrivateOrderDB): void {
    this.db = db;
  }

  loadFromDB(): number {
    if (!this.db) return 0;
    const orders = this.db.loadPending();
    let loaded = 0;
    for (const stored of orders) {
      try {
        this.addInternal(stored);
        loaded++;
      } catch (err) {
        console.warn(`Skipped restoring order ${stored.order.pubKeyAx}:${stored.order.nonce}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
    return loaded;
  }

  add(order: PrivateOrder): StoredPrivateOrder {
    const stored: StoredPrivateOrder = {
      order,
      status: "pending",
      submittedAt: Date.now(),
    };
    this.addInternal(stored);
    if (this.db) {
      try {
        this.db.save(stored);
      } catch (err) {
        this.remove(stored.order);
        throw err;
      }
    }
    return stored;
  }

  private addInternal(stored: StoredPrivateOrder): void {
    if (this.pendingCount >= this.maxSize) {
      throw new Error("orderbook full");
    }
    const { order } = stored;
    const pair = pairKey(order.sellToken, order.buyToken);

    // Dedup by pubKeyAx + nonce
    const pkKey = order.pubKeyAx.toString();
    const nonceKey = order.nonce.toString();
    if (!this.byPubKey.has(pkKey)) {
      this.byPubKey.set(pkKey, new Map());
    }
    if (this.byPubKey.get(pkKey)!.has(nonceKey)) {
      throw new Error("duplicate nonce");
    }
    this.byPubKey.get(pkKey)!.set(nonceKey, stored);
    this.pendingCount++;

    // Determine direction: sell side if sellToken < buyToken (as hex)
    const sellHex = "0x" + order.sellToken.toString(16).padStart(40, "0");
    const buyHex = "0x" + order.buyToken.toString(16).padStart(40, "0");
    const isSellSide = sellHex < buyHex;

    if (isSellSide) {
      // Sorted insertion — price ascending (best ask first for counterparty matching)
      const sellList = this.sells.get(pair) || [];
      const idx = sellList.findIndex((existing) =>
        stored.order.sellAmount * existing.order.buyAmount <
        existing.order.sellAmount * stored.order.buyAmount
      );
      if (idx === -1) sellList.push(stored);
      else sellList.splice(idx, 0, stored);
      this.sells.set(pair, sellList);
    } else {
      // Sorted insertion — price descending (best bid first for counterparty matching)
      const buyList = this.buys.get(pair) || [];
      const idx = buyList.findIndex((existing) =>
        stored.order.buyAmount * existing.order.sellAmount >
        existing.order.buyAmount * stored.order.sellAmount
      );
      if (idx === -1) buyList.push(stored);
      else buyList.splice(idx, 0, stored);
      this.buys.set(pair, buyList);
    }
  }

  remove(order: PrivateOrder): void {
    const pkKey = order.pubKeyAx.toString();
    const nonceKey = order.nonce.toString();
    const stored = this.byPubKey.get(pkKey)?.get(nonceKey);
    if (!stored) return;

    this.byPubKey.get(pkKey)!.delete(nonceKey);
    this.pendingCount--;

    const pair = pairKey(order.sellToken, order.buyToken);
    const sellHex = "0x" + order.sellToken.toString(16).padStart(40, "0");
    const buyHex = "0x" + order.buyToken.toString(16).padStart(40, "0");
    const isSellSide = sellHex < buyHex;

    if (isSellSide) {
      const sellList = this.sells.get(pair);
      if (sellList) this.sells.set(pair, sellList.filter((o) => o !== stored));
    } else {
      const buyList = this.buys.get(pair);
      if (buyList) this.buys.set(pair, buyList.filter((o) => o !== stored));
    }
  }

  cancel(pubKeyAx: bigint, nonce: bigint): StoredPrivateOrder | null {
    const pkKey = pubKeyAx.toString();
    const nonceKey = nonce.toString();
    const stored = this.byPubKey.get(pkKey)?.get(nonceKey);
    if (!stored || stored.status !== "pending") return null;

    stored.status = "cancelled";
    this.remove(stored.order);
    this.db?.updateStatus(pubKeyAx, nonce, "cancelled");
    return stored;
  }

  getSellOrders(pair: string): StoredPrivateOrder[] {
    return (this.sells.get(pair) || []).filter((o) => o.status === "pending");
  }

  getBuyOrders(pair: string): StoredPrivateOrder[] {
    return (this.buys.get(pair) || []).filter((o) => o.status === "pending");
  }

  /** Find a pending order by (pubKeyAx, nonce) composite key */
  getByPubKeyAndNonce(pubKeyAx: bigint, nonce: bigint): StoredPrivateOrder | null {
    const stored = this.byPubKey.get(pubKeyAx.toString())?.get(nonce.toString());
    return (stored && stored.status === "pending") ? stored : null;
  }

  getOrdersByPubKey(pubKeyAx: bigint): StoredPrivateOrder[] {
    const orders = this.byPubKey.get(pubKeyAx.toString());
    if (!orders) return [];
    return Array.from(orders.values());
  }

  getOrderCount(): number {
    return this.pendingCount;
  }

  getOrderHistory(pubKeyAx: bigint, opts: { status?: PrivateOrderStatus; limit: number; offset: number }): StoredPrivateOrder[] {
    if (!this.db) return [];
    return this.db.getOrdersByPubKey(pubKeyAx, opts);
  }

  getOrderByNonce(pubKeyAx: bigint, nonce: bigint): StoredPrivateOrder | null {
    if (!this.db) return null;
    return this.db.getOrderByPubKeyNonce(pubKeyAx, nonce);
  }

  countOrders(pubKeyAx: bigint, status?: PrivateOrderStatus): number {
    if (!this.db) return 0;
    return this.db.countOrdersByPubKey(pubKeyAx, status);
  }

  hasNonce(pubKeyAx: bigint, nonce: bigint): boolean {
    const pkKey = pubKeyAx.toString();
    const nonceKey = nonce.toString();
    if (this.byPubKey.get(pkKey)?.has(nonceKey)) return true;
    return this.db?.hasOrder(pubKeyAx, nonce) ?? false;
  }

  persistStatus(pubKeyAx: bigint, nonce: bigint, status: PrivateOrderStatus, settleTxHash?: string, crossRelayer?: boolean): void {
    this.db?.updateStatus(pubKeyAx, nonce, status, settleTxHash, crossRelayer);
  }

  /** [R-7] Cancel all pending orders — used by admin drain endpoint. */
  cancelAll(): number {
    const toRemove: PrivateOrder[] = [];
    for (const [, orders] of this.byPubKey) {
      for (const [, stored] of orders) {
        if (stored.status === "pending") {
          stored.status = "cancelled";
          this.db?.updateStatus(stored.order.pubKeyAx, stored.order.nonce, "cancelled");
          toRemove.push(stored.order);
        }
      }
    }
    for (const order of toRemove) {
      this.remove(order);
    }
    return toRemove.length;
  }

  purgeExpired(): number {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const toRemove: PrivateOrder[] = [];

    for (const [, orders] of this.byPubKey) {
      for (const [, stored] of orders) {
        if (stored.status === "pending" && stored.order.expiry <= now) {
          stored.status = "expired";
          this.db?.updateStatus(stored.order.pubKeyAx, stored.order.nonce, "expired");
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
