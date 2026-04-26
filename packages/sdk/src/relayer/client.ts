import { sanitizeProfile } from "./profile";
import type {
  OrderData,
  OrderHistoryResponse,
  RelayerApiInfo,
  RelayerOrder,
} from "./types";

/** Default per-call timeout. Relayer probes during list-load
 *  shouldn't stall the UI on one slow node. */
const DEFAULT_TIMEOUT_MS = 5_000;

interface ClientOpts {
  /** Override the per-request timeout. Useful for slow networks
   *  during dev. */
  timeoutMs?: number;
  /** Fetch implementation for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** Talk to one relayer's HTTP API.
 *
 *  This is a thin client. It does not retry, cache, or reorder;
 *  callers compose those concerns. Errors throw with the relayer's
 *  message body when available; the timeout abort fires
 *  AbortError. */
export class RelayerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts: ClientOpts = {}) {
    // Strip trailing slash so the path joins below produce a single
    // separator in every case.
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private signal(extraSignal?: AbortSignal): AbortSignal {
    const controllers: AbortSignal[] = [AbortSignal.timeout(this.timeoutMs)];
    if (extraSignal) controllers.push(extraSignal);
    return controllers.length === 1
      ? controllers[0]!
      : AbortSignal.any(controllers);
  }

  /** Probe `/api/info`. The `profile` field is sanitised before
   *  return — see `sanitizeProfile`. */
  async getInfo(extraSignal?: AbortSignal): Promise<RelayerApiInfo> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/info`, {
      signal: this.signal(extraSignal),
    });
    if (!res.ok) throw new Error(`relayer info ${res.status}: ${res.statusText}`);
    const raw = (await res.json()) as RelayerApiInfo;
    return { ...raw, profile: sanitizeProfile(raw?.profile) };
  }

  /** Submit a signed order to the relayer for matching. */
  async submitOrder(
    order: OrderData,
    signature: string,
    feeMode?: "cover_taker",
  ): Promise<{ status: string; txHash?: string; nonce?: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, signature, ...(feeMode && { feeMode }) }),
      signal: this.signal(),
    });
    if (!res.ok) {
      const err = await this.safeJson(res);
      throw new Error(err?.error ?? `relayer submit ${res.status}: ${res.statusText}`);
    }
    return res.json();
  }

  /** Get all open orders for `address` (no pagination). */
  async getOrders(address: string): Promise<RelayerOrder[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/orders/${address}`, {
      signal: this.signal(),
    });
    if (!res.ok) throw new Error(`relayer orders ${res.status}: ${res.statusText}`);
    return res.json();
  }

  /** Paginated order history with optional status filter. */
  async getOrderHistory(
    address: string,
    opts: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<OrderHistoryResponse> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    params.set("limit", String(opts.limit ?? 50));
    params.set("offset", String(opts.offset ?? 0));
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}?${params}`,
      { signal: this.signal() },
    );
    if (!res.ok) throw new Error(`relayer history ${res.status}: ${res.statusText}`);
    return res.json();
  }

  async getOrderDetail(address: string, nonce: string): Promise<RelayerOrder> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}/${nonce}`,
      { signal: this.signal() },
    );
    if (!res.ok) throw new Error(`relayer order ${res.status}: ${res.statusText}`);
    return res.json();
  }

  async cancelOrder(address: string, nonce: number, signature: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}/${nonce}`,
      {
        method: "DELETE",
        headers: { "x-cancel-signature": signature },
        signal: this.signal(),
      },
    );
    if (!res.ok) {
      const err = await this.safeJson(res);
      throw new Error(err?.error ?? `relayer cancel ${res.status}: ${res.statusText}`);
    }
  }

  /** Read JSON if the body parses; otherwise return null. Used so
   *  the error path doesn't itself throw on malformed bodies. */
  private async safeJson(res: Response): Promise<{ error?: string } | null> {
    try {
      return (await res.json()) as { error?: string };
    } catch {
      return null;
    }
  }
}
