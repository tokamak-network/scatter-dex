import { createHash } from "crypto";
import { Wallet } from "ethers";
import WebSocket from "ws";
import type { OrderSummary } from "../types/order.js";
import { eqAddr } from "../lib/address.js";
import { assertSafeOutboundUrl, UnsafeUrlError } from "../lib/url-guard.js";
import { createLogger } from "./logger.js";

const EMPTY_BODY_SHA256 =
  "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256HexBody(bodyBytes: string | undefined): string {
  if (!bodyBytes || bodyBytes.length === 0) return EMPTY_BODY_SHA256;
  return "0x" + createHash("sha256").update(bodyBytes, "utf8").digest("hex");
}

const log = createLogger("shared-orderbook");

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
  /** EVM network the settle tx landed on. Optional here; pushSettlement
   *  stamps the relayer's chainId when the caller omits it. */
  chainId?: number;
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
  /** PrivateSettlement entry-point — "settleAuth" for two-sided
   *  matches (Pro), "scatterDirectAuth" for single-party payouts
   *  (Pay). Optional for wire back-compat; shared-OB stores NULL
   *  when absent and the operators leaderboard treats those rows
   *  as "unknown" (counted in aggregate, skipped in byApp). */
  type?: "settleAuth" | "scatterDirectAuth";
}

/** Sepolia — the network this relayer operates on when none is configured.
 *  Kept in sync with the shared-orderbook backend's DEFAULT_CHAIN_ID for
 *  backward compatibility with the single-network deployment. */
const DEFAULT_CHAIN_ID = 11155111;

export interface SharedOrderbookConfig {
  serverUrl: string;          // e.g. "http://localhost:4000"
  relayerWallet: Wallet;
  relayerUrl: string;         // this relayer's public URL
  relayerName?: string;
  heartbeatIntervalMs?: number;
  peerSyncIntervalMs?: number;
  /** EVM network this relayer trades on. The shared orderbook is
   *  multi-network; orders / settlements this client posts are stamped with
   *  this chainId and reads are scoped to it. Defaults to Sepolia. */
  chainId?: number;
}

export class SharedOrderbookClient {
  private serverUrl: string;
  private wallet: Wallet;
  private relayerUrl: string;
  private relayerName?: string;
  private chainId: number;
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
    this.chainId = cfg.chainId ?? DEFAULT_CHAIN_ID;
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
   * Generate auth headers with method + path + url + body bound
   * signature. Binding the body sha256 closes the replay-modify
   * window where an in-path attacker could capture a valid signed
   * write and re-send it with a different body before the 5-minute
   * timestamp window expired.
   *
   * `bodyBytes` MUST be exactly the bytes the caller is about to
   * send as the request body. The server hashes the raw bytes it
   * receives via `express.json({ verify })`, so any divergence
   * (whitespace, key order, encoding) fails verification. For GET
   * and DELETE this argument is omitted and the empty-string hash
   * is bound instead.
   */
  async authHeaders(
    method: string,
    path: string,
    bodyBytes?: string,
  ): Promise<Record<string, string>> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const address = this.wallet.address.toLowerCase();
    const bodyHash = sha256HexBody(bodyBytes);
    const message = `zkScatter-relay:${address}:${ts}:${method.toUpperCase()}:${path}:${this.relayerUrl}:${bodyHash}`;
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
      const body = JSON.stringify({ name: this.relayerName });
      const headers = await this.authHeaders("POST", "/api/relayers/register", body);
      const res = await fetch(`${this.serverUrl}/api/relayers/register`, {
        method: "POST",
        headers,
        body,
      });
      if (res.ok) {
        this.serverOnline = true;
        log.info("Registered with server");
      }
    } catch {
      this.serverOnline = false;
      log.warn("Server unreachable, using P2P mode");
    }
  }

  private connectWS(): void {
    try {
      const wsUrl = this.serverUrl.replace(/^http/, "ws") + "/ws/orders";
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.serverOnline = true;
        this.wsReconnectDelay = 1000; // reset backoff on success
        log.info("WebSocket connected");
        // Reconcile on every open (first connect + each reconnect). The
        // shared-OB WS stream only broadcasts NEW events, so without this
        // a relayer that joins/restarts after others have already posted
        // will never see (and thus never match) those existing orders.
        this.syncOpenOrders().catch((err) => {
          log.warn("Snapshot reconcile failed", {
            err: err instanceof Error ? err.message : "unknown",
          });
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data));
          if (data.type === "order:new" && data.order) {
            const order = data.order as OrderSummary;
            // Skip own orders and orders on other networks (the WS stream is
            // cross-chain; the local matcher is single-chain).
            if (!eqAddr(order.relayer, this.wallet.address) && this.isOnThisChain(order)) {
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
          log.warn("Failed to parse WS message", {
            err: err instanceof Error ? err.message : "unknown",
          });
        }
      };

      this.ws.onclose = () => {
        this.serverOnline = false;
        if (this.stopped) return; // Don't reconnect after explicit stop()
        const delay = this.wsReconnectDelay;
        this.wsReconnectDelay = Math.min(delay * 2, SharedOrderbookClient.WS_MAX_RECONNECT_DELAY);
        log.warn("WebSocket disconnected, reconnecting", { delayMs: delay });
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
      const body = "{}";
      const headers = await this.authHeaders("POST", "/api/relayers/heartbeat", body);
      const res = await fetch(`${this.serverUrl}/api/relayers/heartbeat`, {
        method: "POST",
        headers,
        body,
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

  /** Stamp the relayer's network onto an outgoing order so every send path —
   *  postOrder, the P2P fallback, and the self-healing forcePostOrderToServer
   *  sweep — files it under the right chain. An order that already pins a
   *  chainId keeps it. */
  private withChainId<T extends { chainId?: number }>(order: T): T {
    return { ...order, chainId: order.chainId ?? this.chainId };
  }

  /** True when an inbound order belongs to this relayer's network. The shared
   *  orderbook's WS stream + snapshot are cross-chain, so the local matcher
   *  must drop other networks' orders (a missing chainId is a legacy
   *  single-network row → treated as the default chain). */
  private isOnThisChain(order: { chainId?: number }): boolean {
    return (order.chainId ?? DEFAULT_CHAIN_ID) === this.chainId;
  }

  private async postOrderToServer(order: Omit<OrderSummary, "relayer" | "relayerUrl" | "createdAt">): Promise<string | null> {
    try {
      const body = JSON.stringify(this.withChainId(order));
      const headers = await this.authHeaders("POST", "/api/orders", body);
      const res = await fetch(`${this.serverUrl}/api/orders`, {
        method: "POST",
        headers,
        body,
      });
      if (res.ok) {
        // A successful post is evidence the server is reachable —
        // flip serverOnline back on so the next regular publish
        // doesn't keep routing through the empty-peer P2P fallback
        // until heartbeat catches up. Without this the self-healing
        // sweep silently masks a stuck offline flag.
        this.serverOnline = true;
        const data = await res.json() as { id: string };
        return data.id;
      }
      const errText = await res.text().catch(() => "");
      log.warn("postOrder rejected", { status: res.status, body: errText.slice(0, 200) });
      return null;
    } catch (err) {
      this.serverOnline = false;
      log.warn("postOrder server unreachable, falling back to P2P", {
        err: err instanceof Error ? err.message : String(err),
      });
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
      // Stamp the relayer's network so the row is filed under the right chain.
      const body = JSON.stringify({ ...payload, chainId: payload.chainId ?? this.chainId });
      const headers = await this.authHeaders("POST", "/api/settlements", body);
      const res = await fetch(`${this.serverUrl}/api/settlements`, {
        method: "POST",
        headers,
        body,
        // Bound the call so a hung shared-OB doesn't leak file descriptors —
        // matches the timeout posture of postOrderToPeers / broadcastCancel.
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log.warn("pushSettlement non-OK response", { status: res.status, body: text.slice(0, 200) });
        return false;
      }
      return true;
    } catch (err) {
      log.warn("pushSettlement failed", {
        err: err instanceof Error ? err.message : "unknown",
      });
      return false;
    }
  }

  /** Flip an open row to `matched` on the shared orderbook. Called
   *  from the settlement worker after a successful `settleAuth` so
   *  the row leaves the Open/Matching tab without being mis-labelled
   *  as `cancelled` (the prior shape reused `cancelOrder`, which is
   *  semantically a user-initiated abort, not a fill). */
  async markMatched(orderId: string): Promise<boolean> {
    if (!this.serverOnline) return false;
    try {
      const path = `/api/orders/${orderId}/matched`;
      // Pass an empty JSON body so the signature middleware's body-
      // hash check has something to verify against. The heartbeat
      // path above uses the same shape; sending no body lets the
      // hash drift between client and server and rejects the call
      // with an opaque 401.
      const body = "{}";
      const headers = await this.authHeaders("POST", path, body);
      const res = await fetch(`${this.serverUrl}${path}`, {
        method: "POST",
        headers,
        body,
      });
      return res.ok;
    } catch {
      this.serverOnline = false;
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
      const res = await fetch(`${this.serverUrl}/api/orders?chainId=${this.chainId}`);
      if (!res.ok) return;
      const data = await res.json() as { orders: OrderSummary[] };
      let added = 0;
      for (const order of data.orders) {
        if (eqAddr(order.relayer, this.wallet.address)) continue;
        if (!this.isOnThisChain(order)) continue; // snapshot is cross-chain
        if (this.remoteOrders.has(order.id)) continue;
        this.remoteOrders.set(order.id, order);
        this.onOrderCallback?.(order);
        added++;
      }
      if (added > 0) {
        log.info("Reconciled open orders from snapshot", { added });
      }
    } catch (err) {
      // Network failure here isn't fatal — the WS stream is still live
      // and the next reconnect will retry.
      log.warn("syncOpenOrders fetch failed", {
        err: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  /** Republish a single accepted local order. Used by the periodic
   *  self-healing sweep in index.ts when an authorize_orders row that
   *  should be in the shared OB is missing — e.g. because the original
   *  postOrder silently fell through to a P2P broadcast with zero
   *  peers, or because shared-OB rejected the URL once and serverOnline
   *  is now stuck false. Force-tries the server path even if
   *  serverOnline is false; if the server is reachable the request
   *  itself flips serverOnline back to true. */
  async forcePostOrderToServer(order: Omit<OrderSummary, "relayer" | "relayerUrl" | "createdAt">): Promise<string | null> {
    // postOrderToServer reads serverOnline only via its parent
    // postOrder(); calling it directly bypasses the gate. Its catch
    // block already manages serverOnline on its own outcome.
    const result = await this.postOrderToServer(order);
    if (result !== null) {
      log.info("Republished missing order", { id: order.id });
    }
    return result;
  }

  /** Cheap query for the periodic resync — returns the set of order
   *  ids currently held by the shared-OB across all statuses. */
  async fetchAllOrderIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    // shared-OB caps each page at 500 (shared-orderbook/src/routes/
    // orders.ts:96). Walk `offset` in 500-sized chunks until the
    // server returns less than a full page. THROW on any network
    // error or non-OK response — a partial set would look complete
    // to `index.ts`'s sweep, which would then republish handles
    // that actually live in an unseen page (turning into 409 noise
    // for `open` rows, terminal-row replaces for the rest). The
    // sweep's outer try/catch already converts a throw here into a
    // "skip this cycle" — partial knowledge is worse than no scan.
    //
    // Hard cap at 20 pages (10k rows) is a different case: pages
    // 0..19 ARE a valid scan, just truncated at the tail. Surface
    // it as a warn canary so an OB with >10k tracked rows escalates
    // to the operator (purge older terminals), but return the
    // visible set rather than throwing — that's the same data the
    // caller would get from a healthy <10k OB.
    const PAGE_SIZE = 500;
    const MAX_PAGES = 20;
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const res = await fetch(
        `${this.serverUrl}/api/orders?status=all&limit=${PAGE_SIZE}&offset=${offset}&chainId=${this.chainId}`,
      );
      if (!res.ok) {
        throw new Error(`shared-OB GET /api/orders returned ${res.status} on page ${page}`);
      }
      const data = await res.json() as { orders: Array<{ id: string }>; count?: number };
      for (const o of data.orders) ids.add(o.id.toLowerCase());
      // Done when the server returns less than a full page —
      // pagination is dense (no gaps), so a short page == end-of-
      // stream. `count` on the response is just `orders.length`,
      // both checks agree.
      if (data.orders.length < PAGE_SIZE) return ids;
      if (page === MAX_PAGES - 1) {
        log.warn("fetchAllOrderIds hit page cap — sweep may miss older rows", {
          scannedRows: ids.size,
          pageCap: MAX_PAGES,
          pageSize: PAGE_SIZE,
        });
      }
    }
    return ids;
  }

  /** Paged fetch of settlement rows where the given address appears as
   *  submitter, maker, or taker. Used by the local-DB backfill
   *  reconciler to recover rows that exist in shared-OB but went
   *  missing from local storage (typically: a relayer DB reset before
   *  the push-outbox shipped).
   *
   *  `since` is **unix-seconds** to match shared-OB's
   *  `parseSinceQuery` — callers that work in ms must convert. Pages
   *  via `limit` + `offset`; the server clamps `limit` at 500. Rows
   *  are returned in `block_number DESC, tx_hash ASC` order.
   *
   *  Throws on network / HTTP errors so the caller (typically a
   *  one-shot admin endpoint) can report the failure instead of
   *  silently treating it as zero rows. The `serverOnline` heartbeat
   *  is intentionally bypassed — a stale heartbeat shouldn't block a
   *  human-triggered backfill when HTTP is actually reachable. */
  async fetchSettlementsForAddress(
    address: string,
    opts: { since?: number; limit?: number; offset?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    // Use the URL API so a serverUrl with or without trailing slash
    // produces the same canonical request path, and validate the
    // protocol so a misconfigured env var (e.g. `file://`) can't
    // turn into a privileged file read.
    const url = new URL("/api/settlements", this.serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`fetchSettlementsForAddress: unsupported protocol ${url.protocol}`);
    }
    const params = new URLSearchParams({ relayer: address, chainId: String(this.chainId) });
    if (typeof opts.since === "number") params.set("since", String(opts.since));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    if (typeof opts.offset === "number") params.set("offset", String(opts.offset));
    url.search = params.toString();

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `fetchSettlementsForAddress: HTTP ${res.status} ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { settlements?: Array<Record<string, unknown>> };
    return data.settlements ?? [];
  }

  /** Fetch all open orders from server (initial sync or periodic refresh) */
  async fetchOrders(pair?: string): Promise<OrderSummary[]> {
    if (this.serverOnline) {
      try {
        const path = pair ? `/api/orders/${pair}` : "/api/orders";
        const res = await fetch(`${this.serverUrl}${path}?chainId=${this.chainId}`);
        if (res.ok) {
          const data = await res.json() as { orders: OrderSummary[] };
          for (const order of data.orders) {
            if (!eqAddr(order.relayer, this.wallet.address)) {
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
      log.warn("Peer sync failed", { err: err instanceof Error ? err.message : "unknown" });
    }
  }

  /** P2P: post order directly to all known peers */
  private async postOrderToPeers(order: Omit<OrderSummary, "relayer" | "relayerUrl" | "createdAt">): Promise<string | null> {
    const summary: OrderSummary = {
      ...this.withChainId(order),
      relayer: this.wallet.address.toLowerCase(),
      relayerUrl: this.relayerUrl,
      createdAt: Math.floor(Date.now() / 1000),
    };
    const id = summary.id;

    const promises = [...this.peers.values()].map(async (peer) => {
      try {
        // SSRF guard before each peer fetch — see lib/url-guard.ts.
        // Defense in depth against DNS rebinding flipping a known peer
        // hostname to a private IP between sync and broadcast.
        await assertSafeOutboundUrl(peer.url);
        const body = JSON.stringify(summary);
        const headers = await this.authHeaders("POST", "/api/p2p/orders", body);
        await fetch(`${peer.url}/api/p2p/orders`, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          log.warn("Refusing to post to peer (unsafe URL)", { peer: peer.url, reason: e.message });
        }
      }
    });
    await Promise.allSettled(promises);
    return id;
  }

  /** P2P: broadcast cancel to peers */
  private async broadcastCancelToPeers(orderId: string): Promise<boolean> {
    const promises = [...this.peers.values()].map(async (peer) => {
      try {
        await assertSafeOutboundUrl(peer.url);
        const headers = await this.authHeaders("DELETE", `/api/p2p/orders/${orderId}`);
        await fetch(`${peer.url}/api/p2p/orders/${orderId}`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          log.warn("Refusing to cancel on peer (unsafe URL)", { peer: peer.url, reason: e.message });
        }
      }
    });
    await Promise.allSettled(promises);
    return true;
  }

  // ─── Accessors ───

  isServerOnline(): boolean { return this.serverOnline; }
  getRemoteOrders(): OrderSummary[] { return [...this.remoteOrders.values()]; }
  getPeers(): PeerInfo[] { return [...this.peers.values()]; }
}
