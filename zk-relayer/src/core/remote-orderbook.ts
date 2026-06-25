import type { OrderSummary } from "../types/order.js";
import { createLogger } from "./logger.js";

const log = createLogger("remote-orderbook");

/**
 * In-memory store for remote OrderSummary objects received from
 * the shared orderbook (via WebSocket) or directly from peers (P2P).
 *
 * Separate from PrivateOrderbook — remote orders lack secrets
 * and cannot be stored as StoredPrivateOrder.
 */
/** Default hard ceiling on stored remote orders — see `maxSize`. */
const DEFAULT_MAX_SIZE = 10_000;

export class RemoteOrderStore {
  /** pair → OrderSummary[] sorted by price ascending (sell side) */
  private sells = new Map<string, OrderSummary[]>();
  /** pair → OrderSummary[] sorted by price descending (buy side) */
  private buys = new Map<string, OrderSummary[]>();
  /** order ID → OrderSummary */
  private byId = new Map<string, OrderSummary>();
  /** relayer address → Set of order IDs */
  private byRelayer = new Map<string, Set<string>>();

  /**
   * Hard ceiling on the number of stored orders. `/api/p2p/orders` is
   * relayer-signed but permissionless (any keypair passes auth, no
   * allow-list / bond gate), so an attacker can flood unique-id orders.
   * Without a cap `byId` / `byRelayer` / the sorted pair lists grow
   * unbounded (O(N) splice per insert → O(N²)) — a heap/CPU DoS. When
   * full, `add` reclaims expired rows first, then refuses new ones.
   */
  private readonly maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : DEFAULT_MAX_SIZE;
  }

  get size(): number { return this.byId.size; }

  /**
   * Order ids in this store are bytes32 hex strings, which are
   * effectively case-insensitive on the wire — but `Map` keys are not.
   * Normalise everything to lowercase at the boundary so a peer that
   * sends "0xABCD..." can't bypass the ownership check just by
   * differing-case lookup vs what we cached on `add`.
   */
  private normaliseId(id: string): string { return id.toLowerCase(); }

  /** Lowercased relayer address that owns `orderId`, or `null` if unknown. */
  getRelayer(orderId: string): string | null {
    return this.byId.get(this.normaliseId(orderId))?.relayer.toLowerCase() ?? null;
  }

  add(order: OrderSummary): void {
    const id = this.normaliseId(order.id);
    // Skip if already exists
    if (this.byId.has(id)) return;

    // Skip expired
    const now = Math.floor(Date.now() / 1000);
    if (order.expiry <= now) return;

    // Validate BigInt-parseable fields (remote data is untrusted)
    try {
      BigInt(order.sellAmount);
      BigInt(order.buyAmount);
    } catch {
      log.warn("Skipping malformed order: invalid amount", { id: order.id });
      return;
    }

    // DoS cap: bound memory against a flood on permissionless
    // /api/p2p/orders. Reclaim expired rows first, then refuse the new
    // order if still at capacity (dropping the incoming one rather than
    // evicting a live order keeps genuine peer orders sticky; the p2p
    // rate limiter throttles how fast a flood can probe this ceiling).
    if (this.byId.size >= this.maxSize) {
      this.purgeExpired();
      if (this.byId.size >= this.maxSize) {
        log.warn("RemoteOrderStore at capacity; dropping order", {
          id: order.id, size: this.byId.size, max: this.maxSize,
        });
        return;
      }
    }

    // Store with the normalised id so all subsequent lookups (by-id,
    // by-relayer set membership) match what `remove`/`getRelayer` see.
    const normalised: OrderSummary = order.id === id ? order : { ...order, id };
    this.byId.set(id, normalised);

    // Index by relayer
    const relayerKey = order.relayer.toLowerCase();
    if (!this.byRelayer.has(relayerKey)) this.byRelayer.set(relayerKey, new Set());
    this.byRelayer.get(relayerKey)!.add(id);

    // Insert into pair-sorted list
    const pair = pairKeyFromStrings(order.sellToken, order.buyToken);
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();

    if (isSellSide) {
      const list = this.sells.get(pair) ?? [];
      const sellAmt = BigInt(order.sellAmount);
      const buyAmt = BigInt(order.buyAmount);
      // Insert ascending by price (sellAmount/buyAmount)
      const idx = list.findIndex((existing) => {
        const eSell = BigInt(existing.sellAmount);
        const eBuy = BigInt(existing.buyAmount);
        return sellAmt * eBuy < eSell * buyAmt;
      });
      if (idx === -1) list.push(normalised);
      else list.splice(idx, 0, normalised);
      this.sells.set(pair, list);
    } else {
      const list = this.buys.get(pair) ?? [];
      const sellAmt = BigInt(order.sellAmount);
      const buyAmt = BigInt(order.buyAmount);
      // Insert descending by price (sellAmount/buyAmount ratio, higher first)
      const idx = list.findIndex((existing) => {
        const eSell = BigInt(existing.sellAmount);
        const eBuy = BigInt(existing.buyAmount);
        // new.sell/new.buy > existing.sell/existing.buy → new is more generous
        return sellAmt * eBuy > eSell * buyAmt;
      });
      if (idx === -1) list.push(normalised);
      else list.splice(idx, 0, normalised);
      this.buys.set(pair, list);
    }
  }

  remove(orderId: string): void {
    const id = this.normaliseId(orderId);
    const order = this.byId.get(id);
    if (!order) return;

    this.byId.delete(id);
    const relayerKey = order.relayer.toLowerCase();
    const relayerSet = this.byRelayer.get(relayerKey);
    if (relayerSet) {
      relayerSet.delete(id);
      if (relayerSet.size === 0) this.byRelayer.delete(relayerKey);
    }

    const pair = pairKeyFromStrings(order.sellToken, order.buyToken);
    const isSellSide = order.sellToken.toLowerCase() < order.buyToken.toLowerCase();

    if (isSellSide) {
      const list = this.sells.get(pair);
      if (list) this.sells.set(pair, list.filter(o => o.id !== id));
    } else {
      const list = this.buys.get(pair);
      if (list) this.buys.set(pair, list.filter(o => o.id !== id));
    }
  }

  removeByRelayer(relayerAddr: string): void {
    const ids = this.byRelayer.get(relayerAddr.toLowerCase());
    if (!ids) return;
    for (const id of [...ids]) this.remove(id);
    this.byRelayer.delete(relayerAddr.toLowerCase());
  }

  get(orderId: string): OrderSummary | undefined {
    return this.byId.get(this.normaliseId(orderId));
  }

  getSellOrders(pair: string): OrderSummary[] {
    const now = Math.floor(Date.now() / 1000);
    return (this.sells.get(pair) ?? []).filter(o => o.expiry > now);
  }

  getBuyOrders(pair: string): OrderSummary[] {
    const now = Math.floor(Date.now() / 1000);
    return (this.buys.get(pair) ?? []).filter(o => o.expiry > now);
  }

  purgeExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    let count = 0;
    for (const [id, order] of this.byId) {
      if (order.expiry <= now) {
        this.remove(id);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.sells.clear();
    this.buys.clear();
    this.byId.clear();
    this.byRelayer.clear();
  }
}

function pairKeyFromStrings(tokenA: string, tokenB: string): string {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
