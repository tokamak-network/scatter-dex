import { sanitizeProfile } from "./profile";
import { safeJson, timeoutSignal } from "../util/http";
import type {
  FeeMode,
  OrderData,
  OrderHistoryResponse,
  RelayerApiInfo,
  RelayerOrder,
} from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;

interface ClientOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Thin HTTP client for one relayer's API. No retry, no caching;
 *  callers compose those concerns. Errors throw with the relayer's
 *  message body when present. */
export class RelayerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts: ClientOpts = {}) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getInfo(extraSignal?: AbortSignal): Promise<RelayerApiInfo> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/info`, {
      signal: timeoutSignal(this.timeoutMs, extraSignal),
    });
    if (!res.ok) throw httpError("info", res);
    const raw = (await res.json()) as RelayerApiInfo;
    return { ...raw, profile: sanitizeProfile(raw?.profile) };
  }

  async submitOrder(
    order: OrderData,
    signature: string,
    feeMode?: FeeMode,
  ): Promise<{ status: string; txHash?: string; nonce?: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, signature, ...(feeMode && { feeMode }) }),
      signal: timeoutSignal(this.timeoutMs),
    });
    if (!res.ok) {
      const err = await safeJson<{ error?: string }>(res);
      throw new Error(err?.error ?? defaultErrorMsg("submit", res));
    }
    return res.json();
  }

  async getOrders(address: string): Promise<RelayerOrder[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/orders/${address}`, {
      signal: timeoutSignal(this.timeoutMs),
    });
    if (!res.ok) throw httpError("orders", res);
    return res.json();
  }

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
      { signal: timeoutSignal(this.timeoutMs) },
    );
    if (!res.ok) throw httpError("history", res);
    return res.json();
  }

  async getOrderDetail(address: string, nonce: string): Promise<RelayerOrder> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}/${nonce}`,
      { signal: timeoutSignal(this.timeoutMs) },
    );
    if (!res.ok) throw httpError("order", res);
    return res.json();
  }

  async cancelOrder(address: string, nonce: number, signature: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}/${nonce}`,
      {
        method: "DELETE",
        headers: { "x-cancel-signature": signature },
        signal: timeoutSignal(this.timeoutMs),
      },
    );
    if (!res.ok) {
      const err = await safeJson<{ error?: string }>(res);
      throw new Error(err?.error ?? defaultErrorMsg("cancel", res));
    }
  }
}

function httpError(label: string, res: Response): Error {
  return new Error(defaultErrorMsg(label, res));
}

function defaultErrorMsg(label: string, res: Response): string {
  return `relayer ${label} ${res.status}: ${res.statusText}`;
}
