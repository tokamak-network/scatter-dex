import { sanitizeProfile } from "./profile";
import { safeJson, timeoutSignal } from "../util/http";
import type {
  FeeMode,
  OrderData,
  OrderHistoryResponse,
  RelayerApiInfo,
  RelayerOrder,
  RelayerStatsResponse,
} from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;

interface ClientOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Thin HTTP client for one relayer's API. No retry, no caching;
 *  callers compose those concerns. Errors throw with the relayer's
 *  `error` body field when present, falling back to the HTTP
 *  status line. Every method accepts an optional `signal` so
 *  callers can cancel from a UI's `AbortController`. */
export class RelayerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts: ClientOpts = {}) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getInfo(signal?: AbortSignal): Promise<RelayerApiInfo> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/info`, {
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    if (!res.ok) throw await httpError("info", res);
    const raw = (await res.json()) as RelayerApiInfo;
    return { ...raw, profile: sanitizeProfile(raw?.profile) };
  }

  /** Public stats from `/api/relayer/stats` — operational counters
   *  (totalOrders, settledOrders, avgSettleTimeMs, …). No auth, no
   *  PII; surfaces for cross-relayer comparison on the leaderboard. */
  async getStats(signal?: AbortSignal): Promise<RelayerStatsResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/relayer/stats`, {
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    if (!res.ok) throw await httpError("stats", res);
    return (await res.json()) as RelayerStatsResponse;
  }

  async submitOrder(
    order: OrderData,
    signature: string,
    feeMode?: FeeMode,
    signal?: AbortSignal,
  ): Promise<{ status: string; txHash?: string; nonce?: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, signature, ...(feeMode && { feeMode }) }),
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    if (!res.ok) throw await httpError("submit", res);
    return res.json();
  }

  async getOrders(address: string, signal?: AbortSignal): Promise<RelayerOrder[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/orders/${address}`, {
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    if (!res.ok) throw await httpError("orders", res);
    return res.json();
  }

  async getOrderHistory(
    address: string,
    opts: { status?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<OrderHistoryResponse> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    params.set("limit", String(opts.limit ?? 50));
    params.set("offset", String(opts.offset ?? 0));
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}?${params}`,
      { signal: timeoutSignal(this.timeoutMs, opts.signal) },
    );
    if (!res.ok) throw await httpError("history", res);
    return res.json();
  }

  async getOrderDetail(
    address: string,
    nonce: string,
    signal?: AbortSignal,
  ): Promise<RelayerOrder> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}/${nonce}`,
      { signal: timeoutSignal(this.timeoutMs, signal) },
    );
    if (!res.ok) throw await httpError("order", res);
    return res.json();
  }

  async cancelOrder(
    address: string,
    nonce: number,
    signature: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/orders/${address}/${nonce}`,
      {
        method: "DELETE",
        headers: { "x-cancel-signature": signature },
        signal: timeoutSignal(this.timeoutMs, signal),
      },
    );
    if (!res.ok) throw await httpError("cancel", res);
  }

  /** Submit a recipient's claim for the relayer to dispatch. Pairs
   *  with `POST /api/private-claim` on zk-relayer (route validates
   *  the proof + the claimsRoot the relayer settled). The relayer
   *  pays gas in exchange for having earned the settle fee. */
  async submitClaim(
    body: GaslessClaimBody,
    signal?: AbortSignal,
  ): Promise<{ status: string; txHash: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/private-claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    if (!res.ok) throw await httpError("claim", res);
    return (await res.json()) as { status: string; txHash: string };
  }

  /** Submit a same-token scatter authorize proof for the relayer to
   *  dispatch via `scatterDirectAuth`. Pairs with `POST
   *  /api/authorize-orders` on zk-relayer; the order is queued and
   *  the relayer's settlement worker calls the contract once the
   *  pre-flight checks pass. The endpoint returns a 202 with the
   *  nullifier, which the caller polls via {@link pollAuthorizeOrder}
   *  until `settleTxHash` lands. */
  async submitAuthorizeOrder(
    body: AuthorizeOrderBody,
    signal?: AbortSignal,
  ): Promise<AuthorizeOrderStatus> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/authorize-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    if (!res.ok) throw await httpError("authorize-order", res);
    return (await res.json()) as AuthorizeOrderStatus;
  }

  /** Poll the order status. Used after {@link submitAuthorizeOrder}
   *  to wait for the relayer to actually broadcast the
   *  `scatterDirectAuth` tx. */
  async pollAuthorizeOrder(
    nullifier: string,
    signal?: AbortSignal,
  ): Promise<AuthorizeOrderStatus> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/authorize-orders/${nullifier}`,
      { signal: timeoutSignal(this.timeoutMs, signal) },
    );
    if (!res.ok) throw await httpError("authorize-order-status", res);
    return (await res.json()) as AuthorizeOrderStatus;
  }
}

/** Wire-format body for `POST /api/authorize-orders` — same shape
 *  the legacy frontend sends. `publicSignals` is the named-field
 *  view; `publicSignalsArray` mirrors the raw circom output that
 *  the relayer re-verifies. */
export interface AuthorizeOrderBody {
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
  publicSignals: {
    pubKeyBind: string;
    commitmentRoot: string;
    nullifier: string;
    nonceNullifier: string;
    newCommitment: string;
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    maxFee: string;
    expiry: string;
    claimsRoot: string;
    totalLocked: string;
    relayer: string;
    orderHash: string;
  };
  publicSignalsArray: readonly string[];
  tier: number;
  pubKeyAx: string;
  pubKeyAy: string;
}

export interface AuthorizeOrderStatus {
  status: "pending" | "matched" | "submitted" | "confirmed" | "failed" | string;
  submittedAt?: number;
  updatedAt?: number;
  attempt?: number;
  /** Set once the relayer broadcasts the `scatterDirectAuth` tx. */
  settleTxHash: string | null;
  error?: string | null;
  expiresAt?: number;
  nullifier?: string;
  pollUrl?: string;
}

/** Wire-format request body for `POST /api/private-claim`. The
 *  relayer revalidates every field on-chain so the recipient page
 *  doesn't have to sign anything; submitting through a relayer is
 *  purely a gas-payment relationship. */
export interface GaslessClaimBody {
  /** Decimal-string scalars to keep BigInts JSON-safe. */
  proofA: [string, string];
  proofB: [[string, string], [string, string]];
  proofC: [string, string];
  /** Bytes32 hex. */
  claimsRoot: string;
  claimNullifier: string;
  /** Decimal-string bigint. */
  amount: string;
  /** Address. */
  token: string;
  recipient: string;
  /** Decimal-string bigint. */
  releaseTime: string;
}

/** Build a clear Error from a non-OK Response. Tries to parse a
 *  `{ error: string }` body (the relayer's convention) and uses
 *  it as the message; otherwise falls back to the HTTP status
 *  line so the caller never sees a bare HTTP error. */
async function httpError(label: string, res: Response): Promise<Error> {
  const body = await safeJson<{ error?: string }>(res);
  const detail = body?.error ?? `${res.status}: ${res.statusText}`;
  return new Error(`relayer ${label} — ${detail}`);
}
