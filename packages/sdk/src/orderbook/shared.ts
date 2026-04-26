/** Shared orderbook — cross-relayer order discovery service.
 *
 *  Read-only client: fetches stats, the registered relayer list,
 *  and global orders (optionally filtered by trading pair). All
 *  methods return `null` (or `[]`) on transport / parsing failure
 *  so a missing service doesn't surface as a thrown error in the
 *  UI — pages display "no orders" / "service unavailable" empty
 *  states instead of hard-erroring. */

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
}

interface ClientOpts {
  /** Per-call timeout. Defaults to 5 s. */
  timeoutMs?: number;
  /** Test seam. */
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
    const result = await this.fetchJSON<{
      relayers: SharedRelayer[];
      count: number;
    }>("/api/relayers");
    return result?.relayers ?? [];
  }

  async getOrders(limit = 500): Promise<SharedOrder[]> {
    const result = await this.fetchJSON<{ orders: SharedOrder[]; count: number }>(
      `/api/orders?limit=${limit}`,
    );
    return result?.orders ?? [];
  }

  async getOrdersByPair(pair: string): Promise<SharedOrder[]> {
    const result = await this.fetchJSON<{ orders: SharedOrder[]; count: number }>(
      `/api/orders/${encodeURIComponent(pair)}`,
    );
    return result?.orders ?? [];
  }

  /** Returns `null` instead of throwing on any transport / status /
   *  parse failure. Callers treat `null` as "service unavailable". */
  private async fetchJSON<T>(path: string): Promise<T | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
