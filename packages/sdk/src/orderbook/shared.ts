import { timeoutSignal } from "../util/http";

/** Shared orderbook — cross-relayer order discovery service.
 *
 *  Read-only client. Returns `null` / `[]` on transport / parse
 *  failure so missing service surfaces as an empty state in the
 *  UI rather than a thrown error. */

export interface SharedOrderbookStats {
  totalOrders: number;
  pairs: number;
  relayers: number;
}

export interface SharedRelayer {
  address: string;
  url: string;
  name?: string;
  orderCount: number;
  lastHeartbeat: number;
}

/** Lifecycle status the shared orderbook tracks server-side. Mirrors
 *  `@scatter-dex/types`' OrderStatus union — duplicated here so the
 *  SDK consumer doesn't have to pull the types-only package. */
export type SharedOrderStatus = "open" | "matched" | "cancelled" | "expired";

export interface SharedOrder {
  id: string;
  relayer: string;
  relayerUrl: string;
  nonce: string;
  pubKeyAx: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minFillAmount: string;
  maxFee: number;
  expiry: number;
  createdAt: number;
  /** Present when the API was queried with `status=<bucket>` or
   *  `status=all`. Undefined for legacy callers reading the default
   *  "open"-only view — those rows are always open by definition. */
  status?: SharedOrderStatus;
}

interface ClientOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SharedOrderbookClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts: ClientOpts = {}) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async isOnline(): Promise<boolean> {
    const result = await this.fetchJSON<{ status: string }>("/health");
    return result?.status === "ok";
  }

  async getStats(): Promise<SharedOrderbookStats | null> {
    return this.fetchJSON<SharedOrderbookStats>("/api/stats");
  }

  async getRelayers(): Promise<SharedRelayer[]> {
    const result = await this.fetchJSON<{ relayers: SharedRelayer[]; count: number }>(
      "/api/relayers",
    );
    return result?.relayers ?? [];
  }

  async getOrders(limit = 500, status?: SharedOrderStatus | "all"): Promise<SharedOrder[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set("status", status);
    const result = await this.fetchJSON<{ orders: SharedOrder[]; count: number }>(
      `/api/orders?${params.toString()}`,
    );
    return result?.orders ?? [];
  }

  /** Variant that returns the full payload including the per-status
   *  counts the bucket-tab UI needs. Kept as a separate method so
   *  the common `getOrders()` call site doesn't have to destructure
   *  a wrapper every time. */
  async getOrdersWithCounts(
    limit = 500,
    status?: SharedOrderStatus | "all",
  ): Promise<{ orders: SharedOrder[]; counts: Partial<Record<SharedOrderStatus, number>> }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set("status", status);
    const result = await this.fetchJSON<{
      orders: SharedOrder[];
      counts?: Partial<Record<SharedOrderStatus, number>>;
    }>(`/api/orders?${params.toString()}`);
    return { orders: result?.orders ?? [], counts: result?.counts ?? {} };
  }

  async getOrdersByPair(pair: string): Promise<SharedOrder[]> {
    const result = await this.fetchJSON<{ orders: SharedOrder[]; count: number }>(
      `/api/orders/${encodeURIComponent(pair)}`,
    );
    return result?.orders ?? [];
  }

  private async fetchJSON<T>(path: string): Promise<T | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: timeoutSignal(this.timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
