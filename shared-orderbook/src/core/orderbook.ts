import type { OrderSummary, StoredOrder, OrderStatus } from "../types/order.js";
import { pairKey } from "../types/order.js";
import { config } from "../config.js";

/**
 * Relayer registry — models the Steam bot registration pattern.
 * Each relayer registers with the shared orderbook and maintains
 * presence via periodic heartbeats, just as Steam trading bots
 * register their inventory with marketplace sites (CSGOFloat, Buff163).
 */
export interface RelayerInfo {
  address: string;       // Ethereum address (lowercase)
  url: string;           // REST endpoint for webhook notifications
  name?: string;         // human-readable name
  registeredAt: number;  // unix timestamp
  lastHeartbeat: number; // unix timestamp of last ping
  orderCount: number;    // current open order count
}

/**
 * In-memory shared orderbook.
 *
 * Modeled after Steam marketplace aggregators:
 * - Relayers = trading bots (each operates independently with private state)
 * - OrderSummary = public listing (only trade-relevant public fields)
 * - Matching = relayer-side (each relayer finds matches against own private orders)
 * - Settlement = Trade Offer (handled by the settling relayer off-server)
 */
export class SharedOrderbook {
  /** order.id → StoredOrder */
  private orders = new Map<string, StoredOrder>();

  /** pair key → Set of order IDs (sell side: token with lower address is sellToken) */
  private sellSide = new Map<string, Set<string>>();
  /** pair key → Set of order IDs (buy side) */
  private buySide = new Map<string, Set<string>>();

  /** relayer address → RelayerInfo */
  private relayers = new Map<string, RelayerInfo>();

  /** relayer address → Set of order IDs (reverse index for fast purge) */
  private relayerOrders = new Map<string, Set<string>>();

  get size(): number { return this.orders.size; }

  // ─── Relayer registry (Steam bot registration pattern) ───

  registerRelayer(address: string, url: string, name?: string): RelayerInfo {
    // Validate URL format
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("relayer URL must be http or https");
      }
    } catch {
      throw new Error("invalid relayer URL");
    }
    const key = address.toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const existing = this.relayers.get(key);
    const info: RelayerInfo = {
      address: key,
      url,
      name: name ?? existing?.name,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
      orderCount: existing?.orderCount ?? 0,
    };
    this.relayers.set(key, info);
    return info;
  }

  heartbeat(address: string): boolean {
    const info = this.relayers.get(address.toLowerCase());
    if (!info) return false;
    info.lastHeartbeat = Math.floor(Date.now() / 1000);
    return true;
  }

  getRelayer(address: string): RelayerInfo | undefined {
    return this.relayers.get(address.toLowerCase());
  }

  getActiveRelayers(staleThresholdSec = 300): RelayerInfo[] {
    const cutoff = Math.floor(Date.now() / 1000) - staleThresholdSec;
    return [...this.relayers.values()].filter(r => r.lastHeartbeat >= cutoff);
  }

  // ─── Order management (Steam listing pattern) ───

  addOrder(order: OrderSummary): StoredOrder {
    // Duplicate guard — prevent index drift on re-insertion
    if (this.orders.has(order.id)) {
      throw new Error("duplicate order id");
    }

    if (this.orders.size >= config.maxOrders) {
      throw new Error("orderbook full");
    }

    const relayerKey = order.relayer.toLowerCase();
    const relayerInfo = this.relayers.get(relayerKey);
    if (relayerInfo && relayerInfo.orderCount >= config.maxOrdersPerRelayer) {
      throw new Error("relayer order limit reached");
    }

    const stored: StoredOrder = { order, status: "open" };
    this.orders.set(order.id, stored);

    // Index by pair + side
    const pair = pairKey(order.sellToken, order.buyToken);
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();

    if (isSellSide) {
      if (!this.sellSide.has(pair)) this.sellSide.set(pair, new Set());
      this.sellSide.get(pair)!.add(order.id);
    } else {
      if (!this.buySide.has(pair)) this.buySide.set(pair, new Set());
      this.buySide.get(pair)!.add(order.id);
    }

    // Update relayer order count + reverse index
    if (relayerInfo) relayerInfo.orderCount++;
    if (!this.relayerOrders.has(relayerKey)) this.relayerOrders.set(relayerKey, new Set());
    this.relayerOrders.get(relayerKey)!.add(order.id);

    return stored;
  }

  getOrder(id: string): StoredOrder | undefined {
    return this.orders.get(id);
  }

  removeOrder(id: string): boolean {
    const stored = this.orders.get(id);
    if (!stored) return false;

    this.orders.delete(id);
    const { order } = stored;
    const pair = pairKey(order.sellToken, order.buyToken);
    this.sellSide.get(pair)?.delete(id);
    this.buySide.get(pair)?.delete(id);
    this.relayerOrders.get(order.relayer.toLowerCase())?.delete(id);

    // Decrement relayer count
    const relayerInfo = this.relayers.get(order.relayer.toLowerCase());
    if (relayerInfo && relayerInfo.orderCount > 0) relayerInfo.orderCount--;

    return true;
  }

  updateStatus(id: string, status: OrderStatus, matchId?: string): void {
    const stored = this.orders.get(id);
    if (!stored) return;
    stored.status = status;
    if (matchId) stored.matchId = matchId;

    // Remove from pair index if no longer open
    if (status !== "open") {
      const { order } = stored;
      const pair = pairKey(order.sellToken, order.buyToken);
      this.sellSide.get(pair)?.delete(id);
      this.buySide.get(pair)?.delete(id);

      const relayerInfo = this.relayers.get(order.relayer.toLowerCase());
      if (relayerInfo && relayerInfo.orderCount > 0) relayerInfo.orderCount--;
    }
  }

  /** Get counterparty orders for a given order (opposite side of the pair) */
  getCounterpartyOrders(order: OrderSummary): StoredOrder[] {
    const pair = pairKey(order.sellToken, order.buyToken);
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();

    // If this order is on sell side, counterparties are on buy side and vice versa
    const counterIds = isSellSide
      ? this.buySide.get(pair)
      : this.sellSide.get(pair);

    if (!counterIds) return [];

    const result: StoredOrder[] = [];
    for (const id of counterIds) {
      const stored = this.orders.get(id);
      if (stored && stored.status === "open") result.push(stored);
    }
    return result;
  }

  /** List all open orders, optionally filtered by pair */
  listOpen(pair?: string): StoredOrder[] {
    if (pair) {
      const sellIds = this.sellSide.get(pair) ?? new Set<string>();
      const buyIds = this.buySide.get(pair) ?? new Set<string>();
      const result: StoredOrder[] = [];
      for (const id of [...sellIds, ...buyIds]) {
        const stored = this.orders.get(id);
        if (stored && stored.status === "open") result.push(stored);
      }
      return result.sort((a, b) => a.order.createdAt - b.order.createdAt);
    }

    return [...this.orders.values()]
      .filter(s => s.status === "open")
      .sort((a, b) => a.order.createdAt - b.order.createdAt);
  }

  /** Purge expired orders, returns count removed */
  purgeExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    let count = 0;
    for (const [id, stored] of this.orders) {
      if (stored.status === "open" && stored.order.expiry <= now) {
        this.updateStatus(id, "expired");
        count++;
      }
    }
    return count;
  }

  /** Purge orders from stale relayers (no heartbeat for threshold seconds) */
  purgeStaleRelayers(staleThresholdSec = 600): string[] {
    const cutoff = Math.floor(Date.now() / 1000) - staleThresholdSec;
    const staleRelayers: string[] = [];

    for (const [addr, info] of this.relayers) {
      if (info.lastHeartbeat < cutoff) {
        staleRelayers.push(addr);
      }
    }

    for (const addr of staleRelayers) {
      // O(k) where k = orders of this relayer, not O(n) total orders
      const orderIds = this.relayerOrders.get(addr);
      if (orderIds) {
        for (const id of [...orderIds]) {
          const stored = this.orders.get(id);
          if (stored && stored.status === "open") {
            this.updateStatus(id, "expired");
          }
        }
        this.relayerOrders.delete(addr);
      }
      this.relayers.delete(addr);
    }

    return staleRelayers;
  }

  /** Restore from DB rows */
  loadFromStored(orders: StoredOrder[]): number {
    let count = 0;
    for (const stored of orders) {
      if (stored.status !== "open") continue;
      this.orders.set(stored.order.id, stored);
      const pair = pairKey(stored.order.sellToken, stored.order.buyToken);
      const isSellSide = stored.order.sellToken.toLowerCase() < stored.order.buyToken.toLowerCase();
      if (isSellSide) {
        if (!this.sellSide.has(pair)) this.sellSide.set(pair, new Set());
        this.sellSide.get(pair)!.add(stored.order.id);
      } else {
        if (!this.buySide.has(pair)) this.buySide.set(pair, new Set());
        this.buySide.get(pair)!.add(stored.order.id);
      }
      const rKey = stored.order.relayer.toLowerCase();
      if (!this.relayerOrders.has(rKey)) this.relayerOrders.set(rKey, new Set());
      this.relayerOrders.get(rKey)!.add(stored.order.id);
      count++;
    }
    return count;
  }

  /** Get orderbook stats */
  getStats(): { totalOrders: number; pairs: number; relayers: number } {
    const pairSet = new Set<string>();
    for (const stored of this.orders.values()) {
      if (stored.status === "open") {
        pairSet.add(pairKey(stored.order.sellToken, stored.order.buyToken));
      }
    }
    return {
      totalOrders: [...this.orders.values()].filter(s => s.status === "open").length,
      pairs: pairSet.size,
      relayers: this.relayers.size,
    };
  }
}
