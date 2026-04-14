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

  async getOrderStatus(
    pubKeyAx: string,
    relayerUrl?: string,
  ): Promise<OrderStatus[]> {
    const url = `${relayerUrl || this.getBaseUrl()}/api/private-orders/${pubKeyAx}`;
    const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_READ_MS });
    if (!res.ok) throw new Error(`Failed to fetch order status: ${res.status}`);
    return res.json();
  },

  async getOrderbook(
    pair: string,
    relayerUrl?: string,
  ): Promise<any[]> {
    const url = `${relayerUrl || this.getBaseUrl()}/api/orderbook/${pair}`;
    const res = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_READ_MS });
    if (!res.ok) throw new Error(`Failed to fetch orderbook: ${res.status}`);
    return res.json();
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
