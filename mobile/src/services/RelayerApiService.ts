/**
 * RelayerApiService — 릴레이어 REST API 클라이언트
 *
 * 웹 프론트엔드의 relayerApi.ts를 모바일에 맞게 포팅.
 * fetch API는 React Native에서 동일하게 사용 가능.
 */
import { ethers } from 'ethers';
import { ConfigService } from './ConfigService';
import { ProviderService } from './ProviderService';
import { fetchWithTimeout, TIMEOUT_PROBE_MS, TIMEOUT_READ_MS, TIMEOUT_SUBMIT_MS } from '../lib/http';
import { RELAYER_REGISTRY_ABI } from '../lib/contracts';
import { COMMIT_TREE_DEPTH } from '../lib/zk/constants';

export interface RelayerInfo {
  address: string;
  url: string;
  fee: number;      // basis points
  active: boolean;
  online?: boolean; // set by discoverRelayers() after probing /api/info
}

export interface PrivateOrderRequest {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: string;
  expiry: string;
  nonce: string;
  pubKeyAx: string;
  pubKeyAy: string;
  sigS: string;
  sigR8x: string;
  sigR8y: string;
  ownerSecret: string;
  balance: string;
  salt: string;
  leafIndex: number;
  newSalt: string;
  expectedChangeCommitment: string;
  claims: {
    secret: string;
    recipient: string;
    token: string;
    amount: string;
    releaseTime: string;
  }[];
}

export interface PrivateOrderResponse {
  orderId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}

/**
 * Shape returned by `GET /api/private-orders/:pubKeyAx`. Mirrors
 * zk-relayer's `PrivateOrderResponse` (see zk-relayer/src/types/order.ts:257).
 * bigint-backed numeric fields (sellToken/buyToken/amounts/maxFee/expiry/
 * nonce/pubKeyA{x,y}) are returned as decimal strings; other fields keep
 * their native API representations (`status` as an enum string,
 * `settleTxHash` as an 0x tx hash, `crossRelayer` as a boolean,
 * `submittedAt` as a number).
 */
export interface OrderStatus {
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  maxFee?: string;
  expiry?: string;
  nonce?: string;
  pubKeyAx?: string;
  pubKeyAy?: string;
  status: 'pending' | 'matched' | 'settled' | 'cancelled' | 'expired';
  submittedAt?: number;
  settleTxHash?: string;
  crossRelayer?: boolean;
  /** Deprecated alias. Present so existing callers that key by `orderId` do not
   *  immediately break; prefer `nonce` for cancellation. */
  orderId?: string;
}

/**
 * Response from `GET /api/info/merkle-proof?leafIndex=N`. The relayer
 * maintains the commitment Merkle tree in memory, so this is the fast
 * path — mobile can skip the full `CommitmentInserted` event scan and
 * local tree rebuild on every order submission. Decimal-string fields.
 */
export interface MerkleProofResponse {
  root: string;
  pathElements: string[];
  pathIndices: number[];
}

/**
 * Response from `GET /api/authorize-orders/:nullifier`. Matches the
 * `buildStatusReply` shape defined in
 * zk-relayer/src/routes/authorize-orders.ts. `status` covers both the
 * legacy enum (pending/matched/settled/cancelled/expired) and the new
 * async-settlement FSM (accepted/settling/retrying/failed/dead_letter)
 * — see docs/design/async-settlement-protocol.md §2.3.
 */
export interface AuthorizeOrderStatusResponse {
  status:
    | 'pending'
    | 'matched'
    | 'accepted'
    | 'settling'
    | 'retrying'
    | 'settled'
    | 'failed'
    | 'dead_letter'
    | 'cancelled'
    | 'expired';
  submittedAt: number;
  updatedAt: number;
  attempt: number;
  settleTxHash: string | null;
  error: string | null;
  expiresAt: number | null;
}

export interface PrivateClaimRequest {
  proofA: string[];
  proofB: string[][];
  proofC: string[];
  claimsRoot: string;
  claimNullifier: string;
  amount: string;
  token: string;
  recipient: string;
  releaseTime: string;
}

export interface PrivateClaimResponse {
  txHash: string;
}

export const RelayerApiService = {
  getBaseUrl(): string {
    return ConfigService.getRelayerUrl();
  },

  async submitPrivateOrder(
    order: PrivateOrderRequest,
    relayerUrl?: string,
  ): Promise<PrivateOrderResponse> {
    const url = `${relayerUrl || this.getBaseUrl()}/api/private-orders`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
      timeoutMs: TIMEOUT_SUBMIT_MS,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relayer rejected order: ${res.status} ${text}`);
    }
    return res.json();
  },

  /**
   * Submit a client-generated authorize.circom proof to the relayer.
   * Mirrors frontend/app/trade/private-order/page.tsx's POST shape exactly
   * so the relayer can validate the proof, pubKey binding, and public
   * signals (named + array) in one request.
   */
  async submitAuthorizeOrder(
    body: {
      proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] } | any;
      publicSignals: Record<string, string>;
      publicSignalsArray: string[];
      pubKeyAx: string;
      pubKeyAy: string;
    },
    relayerUrl?: string,
  ): Promise<{ orderId?: string; [k: string]: any }> {
    const url = `${relayerUrl || this.getBaseUrl()}/api/authorize-orders`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_SUBMIT_MS,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relayer rejected order: ${res.status} ${text}`);
    }
    return res.json();
  },

  /**
   * Poll a single order's status by nullifier. The relayer (post
   * async-settlement protocol) is the source of truth here — the request
   * is fast and its response is idempotent, so it's safe to call
   * repeatedly from a poll loop.
   *
   * Returns `null` on 404 (order unknown) or on a malformed body. Network
   * errors throw so the caller's backoff loop can react.
   */
  async getAuthorizeOrderStatus(
    nullifier: string,
    relayerUrl?: string,
    /** Optional per-call timeout override. Defaults to `TIMEOUT_READ_MS`
     *  (5 s) for the normal poll path; callers on tight budgets (e.g.
     *  OrderService's abort-recovery probe) pass a shorter value so a
     *  slow relayer can't eat the whole recovery window. */
    timeoutMs: number = TIMEOUT_READ_MS,
  ): Promise<AuthorizeOrderStatusResponse | null> {
    const base = relayerUrl || this.getBaseUrl();
    const res = await fetchWithTimeout(`${base}/api/authorize-orders/${nullifier}`, {
      timeoutMs,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`authorize-orders status ${res.status}`);
    }
    // res.json() throws on invalid/empty body. The poll loop treats a
    // throw as a network failure and engages backoff — but a malformed
    // 200 isn't really a network problem, it's "this row is currently
    // unparseable, leave it for the next tick". Fall through to the
    // null path so the caller can no-op without slowing the cadence.
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return null;
    }
    if (!isAuthorizeOrderStatus(data)) return null;
    return data;
  },

  async getOrderStatus(pubKeyAx: string, relayerUrl?: string): Promise<OrderStatus[]> {
    return relayerGetJson(
      `${relayerUrl || this.getBaseUrl()}/api/private-orders/${pubKeyAx}`,
      'order status',
    );
  },

  /**
   * Fetch a Merkle proof for `leafIndex` from the relayer's in-memory tree.
   * Returns `null` on any failure (network error, non-2xx, malformed body) —
   * the caller is expected to fall back to a local event-scan + rebuild.
   * Validates the response shape so a partial payload can't slip through
   * and then fail deep inside the circuit input binding.
   */
  async getMerkleProof(
    leafIndex: number,
    relayerUrl?: string,
  ): Promise<MerkleProofResponse | null> {
    const url = `${relayerUrl || this.getBaseUrl()}/api/info/merkle-proof?leafIndex=${leafIndex}`;
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_READ_MS });
      if (!res.ok) return null;
      const data: unknown = await res.json();
      if (!isMerkleProofResponse(data)) return null;
      return data;
    } catch {
      return null;
    }
  },

  async getOrderbook(pair: string, relayerUrl?: string): Promise<any[]> {
    return relayerGetJson(
      `${relayerUrl || this.getBaseUrl()}/api/orderbook/${pair}`,
      'orderbook',
    );
  },

  /**
   * Fetch active relayers from the on-chain registry and probe each /api/info.
   * Returns every successfully-loaded registry entry annotated with
   * `online=true|false` based on whether the URL responded within 3s.
   * Callers should filter on `online` to pick a working relayer — the
   * returned address is what the authorize circuit hashes, so using the
   * wrong address produces an invalid signature.
   */
  async discoverRelayers(): Promise<RelayerInfo[]> {
    const registryAddr = ConfigService.getRelayerRegistryAddress();
    if (!registryAddr) return [];
    const registry = new ethers.Contract(
      registryAddr,
      RELAYER_REGISTRY_ABI,
      ProviderService.getReadProvider(),
    );
    let activeAddrs: string[];
    try {
      activeAddrs = await registry.getActiveRelayers();
    } catch (err) {
      console.warn('RelayerRegistry.getActiveRelayers failed:', err);
      return [];
    }
    const onChain = await Promise.all(
      activeAddrs.map(async (addr: string) => {
        try {
          const r = await registry.relayers(addr);
          return {
            address: addr,
            url: r.url as string,
            fee: Number(r.fee),
            active: r.active as boolean,
          };
        } catch {
          return null;
        }
      }),
    );
    return Promise.all(
      onChain.filter((r): r is NonNullable<typeof r> => !!r).map(async (r) => {
        try {
          const res = await fetchWithTimeout(`${r.url}/api/info`, { timeoutMs: TIMEOUT_PROBE_MS });
          return { ...r, online: res.ok };
        } catch {
          return { ...r, online: false };
        }
      }),
    );
  },

  /**
   * Gasless claim — relayer pays gas and typically deducts a fee from the
   * claim amount (off-chain contract between user and relayer). The relayer
   * is expected to call claimWithProof on-chain with the supplied fields.
   */
  async submitPrivateClaim(
    claim: PrivateClaimRequest,
    relayerUrl: string,
  ): Promise<PrivateClaimResponse> {
    const base = relayerUrl || this.getBaseUrl();
    const res = await fetchWithTimeout(`${base}/api/private-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claim),
      timeoutMs: TIMEOUT_SUBMIT_MS,
    });
    let data: any;
    try { data = await res.json(); } catch {
      throw new Error(`Invalid JSON response from relayer (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(data?.error || `Relayer rejected claim (${res.status})`);
    }
    // Validate shape so a malformed 200 response can't fool the UI into
    // "success". Expected: 0x-prefixed 32-byte hex (66 chars total).
    if (typeof data?.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(data.txHash)) {
      throw new Error('Relayer response missing or malformed txHash');
    }
    return { txHash: data.txHash };
  },

  async healthCheck(relayerUrl?: string): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${relayerUrl || this.getBaseUrl()}/health`, { timeoutMs: TIMEOUT_READ_MS });
      return res.ok;
    } catch {
      return false;
    }
  },
};

// Shared GET + ok-check + json shape used by the relayer read paths.
async function relayerGetJson<T>(url: string, label: string): Promise<T> {
  const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_READ_MS });
  if (!res.ok) throw new Error(`Failed to fetch ${label}: ${res.status}`);
  return res.json();
}

function isBigIntString(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  try { BigInt(v); return true; } catch { return false; }
}

const KNOWN_STATUSES = new Set([
  'pending', 'matched', 'accepted', 'settling', 'retrying',
  'settled', 'failed', 'dead_letter', 'cancelled', 'expired',
]);

function isAuthorizeOrderStatus(x: unknown): x is AuthorizeOrderStatusResponse {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.status !== 'string' || !KNOWN_STATUSES.has(o.status)) return false;
  if (typeof o.submittedAt !== 'number') return false;
  if (typeof o.updatedAt !== 'number') return false;
  if (typeof o.attempt !== 'number') return false;
  if (o.settleTxHash !== null && typeof o.settleTxHash !== 'string') return false;
  if (o.error !== null && typeof o.error !== 'string') return false;
  if (o.expiresAt !== null && typeof o.expiresAt !== 'number') return false;
  return true;
}

function isMerkleProofResponse(x: unknown): x is MerkleProofResponse {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (!isBigIntString(o.root)) return false;
  // Exact-depth check — the circuit is hard-wired to COMMIT_TREE_DEPTH, and
  // a mismatched length would only surface as a witness-generation failure
  // after we've already committed to the relayer path. Reject here so the
  // local fallback runs.
  if (!Array.isArray(o.pathElements) || o.pathElements.length !== COMMIT_TREE_DEPTH) return false;
  if (!o.pathElements.every(isBigIntString)) return false;
  if (!Array.isArray(o.pathIndices) || o.pathIndices.length !== COMMIT_TREE_DEPTH) return false;
  if (!o.pathIndices.every((i) => i === 0 || i === 1)) return false;
  return true;
}
