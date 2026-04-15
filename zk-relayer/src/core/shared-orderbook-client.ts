import { Wallet } from "ethers";
import WebSocket from "ws";
import type { OrderSummary } from "../types/order.js";

/**
 * Shared Orderbook Client — connects relayer to the shared orderbook server.
 *
 * Two modes of operation (Steam bot analogy):
 * 1. **Server mode** (normal): Relayer posts listings to the central marketplace
 *    and subscribes to new orders via WebSocket.
 * 2. **P2P mode** (fallback): When the server is down, relayer communicates
 *    directly with known peers to exchange order summaries — like Steam bots
 *    that can trade directly via Trade Offers without the marketplace site.
 */

export interface PeerInfo {
  address: string;
  url: string;
  name?: string;
  lastSeen: number;
}

// Re-export OrderSummary from types for backward compatibility
export type { OrderSummary } from "../types/order.js";

// Mirrors shared-orderbook/src/types/settlement.ts SettlementInsert. Kept
// inline (not imported) so this client stays a leaf module — the
// shared-OB schema is the source of truth for field shape.
export interface SettlementPushPayload {
  txHash: string;
  blockNumber: number;
  blockTime?: number;
  makerRelayer: string;
  takerRelayer?: string;
  makerOrderId?: string;
  takerOrderId?: string;
  makerNullifier: string;
  takerNullifier: string;
  feeMaker: string;
  feeTaker: string;
  userMaxFeeMaker: number;
  userMaxFeeTaker: number;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
}

export interface SharedOrderbookConfig {
  serverUrl: string;          // e.g. "http://localhost:4000"
  relayerWallet: Wallet;
  relayerUrl: string;         // this relayer's public URL
  relayerName?: string;
  heartbeatIntervalMs?: number;
  peerSyncIntervalMs?: number;
}

export class SharedOrderbookClient {
  private serverUrl: string;
  private wallet: Wallet;
  private relayerUrl: string;
  private relayerName?: string;
  private wsReconnectDelay = 1000; // exponential backoff start (ms)
  private static readonly WS_MAX_RECONNECT_DELAY = 60_000;
  private heartbeatIntervalMs: number;
  private peerSyncIntervalMs: number;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private peerSyncTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private serverOnline = false;
  private peers = new Map<string, PeerInfo>();
  private remoteOrders = new Map<string, OrderSummary>();
  private onOrderCallback?: (order: OrderSummary) => void;
  private onCancelCallback?: (orderId: string) => void;

  constructor(cfg: SharedOrderbookConfig) {
    this.serverUrl = cfg.serverUrl;
    this.wallet = cfg.relayerWallet;
    this.relayerUrl = cfg.relayerUrl;
    this.relayerName = cfg.relayerName;
    this.heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? 60_000;
    this.peerSyncIntervalMs = cfg.peerSyncIntervalMs ?? 120_000;
  }

  /** Register callback for new remote orders (used by local matcher) */
  onOrder(cb: (order: OrderSummary) => void): void {
    this.onOrderCallback = cb;
  }

  onCancel(cb: (orderId: string) => void): void {
    this.onCancelCallback = cb;
  }

  // ─── Auth helpers ───

  /**
   * Generate auth headers with method+path bound signature
   * to prevent cross-endpoint replay attacks.
   */
  async authHeaders(method: string, path: string): Promise<Record<string, string>> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const address = this.wallet.address.toLowerCase();
    const message = `zkScatter-relay:${address}:${ts}:${method.toUpperCase()}:${path}:${this.relayerUrl}`;
    const signature = await this.wallet.signMessage(message);
    return {
      "x-relayer-address": this.wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": this.relayerUrl,
      "Content-Type": "application/json",
    };
  }

  // ─── Server mode ───

  async start(): Promise<void> {
    this.stopped = false;

    // 1. Register with server
    await this.register();

    // 2. Connect WebSocket
    this.connectWS();

    // 3. Start heartbeat
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);

    // 4. Start peer sync (for P2P fallback cache)
    this.peerSyncTimer = setInterval(() => this.syncPeers(), this.peerSyncIntervalMs);
    await this.syncPeers();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.peerSyncTimer) clearInterval(this.peerSyncTimer);
    this.heartbeatTimer = null;
    this.peerSyncTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  async register(): Promise<void> {
    try {
      const headers = await this.authHeaders("POST", "/api/relayers/register");
      const res = await fetch(`${this.serverUrl}/api/relayers/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: this.relayerName }),
      });
      if (res.ok) {
        this.serverOnline = true;
        console.log("[shared-orderbook] Registered with server");
      }
    } catch {
      this.serverOnline = false;
      console.warn("[shared-orderbook] Server unreachable, using P2P mode");
    }
  }

  private connectWS(): void {
    try {
      const wsUrl = this.serverUrl.replace(/^http/, "ws") + "/ws/orders";
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.serverOnline = true;
        this.wsReconnectDelay = 1000; // reset backoff on success
        console.log("[shared-orderbook] WebSocket connected");
        // Reconcile on every open (first connect + each reconnect). The
        // shared-OB WS stream only broadcasts NEW events, so without this
        // a relayer that joins/restarts after others have already posted
        // will never see (and thus never match) those existing orders.
        this.syncOpenOrders().catch((err) => {
          console.warn(
            "[shared-orderbook] Snapshot reconcile failed:",
            err instanceof Error ? err.message : "unknown",
          );
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data));
          if (data.type === "order:new" && data.order) {
            const order = data.order as OrderSummary;
            // Skip own orders
            if (order.relayer.toLowerCase() !== this.wallet.address.toLowerCase()) {
              // De-dup against the snapshot path: if syncOpenOrders already
              // fired the callback for this id (common on reconnect), don't
              // invoke it again. Downstream matcher guards would catch the
              // redundancy but re-running the full scan is wasted work.
              const isNew = !this.remoteOrders.has(order.id);
              this.remoteOrders.set(order.id, order);
              if (isNew) this.onOrderCallback?.(order);
            }
          } else if (data.type === "order:cancelled" && data.orderId) {
            this.remoteOrders.delete(data.orderId);
            this.onCancelCallback?.(data.orderId);
          }
        } catch (err) {
          console.warn("[shared-orderbook] Failed to parse WS message:", err instanceof Error ? err.message : "unknown");
        }
      };

      this.ws.onclose = () => {
        this.serverOnline = false;
        if (this.stopped) return; // Don't reconnect after explicit stop()
        const delay = this.wsReconnectDelay;
        this.wsReconnectDelay = Math.min(delay * 2, SharedOrderbookClient.WS_MAX_RECONNECT_DELAY);
        console.warn(`[shared-orderbook] WebSocket disconnected, reconnecting in ${delay}ms...`);
        setTimeout(() => { if (!this.stopped) this.connectWS(); }, delay);
      };

      this.ws.onerror = () => {
        this.serverOnline = false;
      };
    } catch {
      this.serverOnline = false;
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      const headers = await this.authHeaders("POST", "/api/relayers/heartbeat");
      const res = await fetch(`${this.serverUrl}/api/relayers/heartbeat`, {
        method: "POST",
        headers,
        body: "{}",
      });
      this.serverOnline = res.ok;
    } catch {
      this.serverOnline = false;
    }
  }

  // ─── Order operations ───

  /** Post an order summary to the shared orderbook */
  async postOrder(order: Omit<OrderSummary, "relayer" | "relayerUrl" | "createdAt">): Promise<string | null> {
    if (this.serverOnline) {
      return this.postOrderToServer(order);
    }
    // P2P fallback: broadcast to known peers
    return this.postOrderToPeers(order);
  }

  private async postOrderToServer(order: Omit<OrderSummary, "relayer" | "relayerUrl" | "createdAt">): Promise<string | null> {
    try {
      const headers = await this.authHeaders("POST", "/api/orders");
      const res = await fetch(`${this.serverUrl}/api/orders`, {
        method: "POST",
        headers,
        body: JSON.stringify(order),
      });
      if (res.ok) {
        const data = await res.json() as { id: string };
        return data.id;
      }
      const body = await res.text().catch(() => "");
      console.warn(`[shared-orderbook] postOrder rejected: HTTP ${res.status} ${body.slice(0, 200)}`);
      return null;
    } catch (err) {
      this.serverOnline = false;
      console.warn(`[shared-orderbook] postOrder server unreachable, falling back to P2P:`, err instanceof Error ? err.message : err);
      return this.postOrderToPeers(order);
    }
  }

  /**
   * Push a completed settlement to the shared OB (Phase 2.5a). Fire-and-forget
   * — settlement bookkeeping must not block the on-chain settle path. Returns
   * true if the server stored the row (or already had it), false on failure.
   * Failures are logged but never thrown; the verify job (Phase 2.5b) and
   * the on-chain backfill scan are designed to recover any rows the push
   * misses.
   */
  async pushSettlement(payload: SettlementPushPayload): Promise<boolean> {
    if (!this.serverOnline) return false;
    try {
      const headers = await this.authHeaders("POST", "/api/settlements");
      const res = await fetch(`${this.serverUrl}/api/settlements`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        // Bound the call so a hung shared-OB doesn't leak file descriptors —
        // matches the timeout posture of postOrderToPeers / broadcastCancel.
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[shared-orderbook] pushSettlement HTTP ${res.status}: ${text.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(
        "[shared-orderbook] pushSettlement failed:",
        err instanceof Error ? err.message : "unknown",
      );
      return false;
    }
  }

  /** Cancel an order on the shared orderbook */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.serverOnline) {
      try {
        const headers = await this.authHeaders("DELETE", `/api/orders/${orderId}`);
        const res = await fetch(`${this.serverUrl}/api/orders/${orderId}`, {
          method: "DELETE",
          headers,
        });
        return res.ok;
      } catch {
        this.serverOnline = false;
      }
    }
    // P2P: broadcast cancel to peers
    return this.broadcastCancelToPeers(orderId);
  }

  /**
   * Pull the current open-orders snapshot and fire `onOrderCallback` for
   * any order the local side hasn't already seen. Used on (re)connect —
   * the WS stream only carries *new* events, so historical orders posted
   * while this relayer was offline/uninitialised never reach the local
   * matcher otherwise.
   */
  private async syncOpenOrders(): Promise<void> {
    try {
      const res = await fetch(`${this.serverUrl}/api/orders`);
      if (!res.ok) return;
      const data = await res.json() as { orders: OrderSummary[] };
      const myAddr = this.wallet.address.toLowerCase();
      let added = 0;
      for (const order of data.orders) {
        if (order.relayer.toLowerCase() === myAddr) continue;
        if (this.remoteOrders.has(order.id)) continue;
        this.remoteOrders.set(order.id, order);
        this.onOrderCallback?.(order);
        added++;
      }
      if (added > 0) {
        console.log(`[shared-orderbook] Reconciled ${added} open order(s) from snapshot`);
      }
    } catch (err) {
      // Network failure here isn't fatal — the WS stream is still live
      // and the next reconnect will retry.
      console.warn(
        "[shared-orderbook] syncOpenOrders fetch failed:",
        err instanceof Error ? err.message : "unknown",
      );
    }
  }

  /** Fetch all open orders from server (initial sync or periodic refresh) */
  async fetchOrders(pair?: string): Promise<OrderSummary[]> {
    if (this.serverOnline) {
      try {
        const path = pair ? `/api/orders/${pair}` : "/api/orders";
        const res = await fetch(`${this.serverUrl}${path}`);
        if (res.ok) {
          const data = await res.json() as { orders: OrderSummary[] };
          for (const order of data.orders) {
            if (order.relayer.toLowerCase() !== this.wallet.address.toLowerCase()) {
              this.remoteOrders.set(order.id, order);
            }
          }
          return data.orders;
        }
      } catch {
        this.serverOnline = false;
      }
    }
    // Fallback: return cached remote orders
    return [...this.remoteOrders.values()];
  }

  // ─── P2P fallback ───

  private async syncPeers(): Promise<void> {
    if (!this.serverOnline) return;
    try {
      const headers = await this.authHeaders("GET", "/api/peers");
      const res = await fetch(`${this.serverUrl}/api/peers`, { headers });
      if (res.ok) {
        const data = await res.json() as { peers: PeerInfo[] };
        for (const peer of data.peers) {
          this.peers.set(peer.address, { ...peer, lastSeen: Date.now() / 1000 });
        }
      }
    } catch (err) {
      console.warn("[shared-orderbook] Peer sync failed:", err instanceof Error ? err.message : "unknown");
    }
  }

  /** P2P: post order directly to all known peers */
  private async postOrderToPeers(order: Omit<OrderSummary, "relayer" | "relayerUrl" | "createdAt">): Promise<string | null> {
    const summary: OrderSummary = {
      ...order,
      relayer: this.wallet.address.toLowerCase(),
      relayerUrl: this.relayerUrl,
      createdAt: Math.floor(Date.now() / 1000),
    };
    const id = summary.id;

    const promises = [...this.peers.values()].map(async (peer) => {
      try {
        const headers = await this.authHeaders("POST", "/api/p2p/orders");
        await fetch(`${peer.url}/api/p2p/orders`, {
          method: "POST",
          headers,
          body: JSON.stringify(summary),
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
    });
    await Promise.allSettled(promises);
    return id;
  }

  /** P2P: broadcast cancel to peers */
  private async broadcastCancelToPeers(orderId: string): Promise<boolean> {
    const promises = [...this.peers.values()].map(async (peer) => {
      try {
        const headers = await this.authHeaders("DELETE", `/api/p2p/orders/${orderId}`);
        await fetch(`${peer.url}/api/p2p/orders/${orderId}`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
    });
    await Promise.allSettled(promises);
    return true;
  }

  // ─── Accessors ───

  isServerOnline(): boolean { return this.serverOnline; }
  getRemoteOrders(): OrderSummary[] { return [...this.remoteOrders.values()]; }
  getPeers(): PeerInfo[] { return [...this.peers.values()]; }
}
