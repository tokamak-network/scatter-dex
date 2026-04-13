/**
 * RelayerApiService — 릴레이어 REST API 클라이언트
 *
 * 웹 프론트엔드의 relayerApi.ts를 모바일에 맞게 포팅.
 * fetch API는 React Native에서 동일하게 사용 가능.
 */
import { ConfigService } from './ConfigService';

export interface RelayerInfo {
  address: string;
  url: string;
  fee: number;      // basis points
  active: boolean;
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

export interface OrderStatus {
  orderId: string;
  status: 'pending' | 'matched' | 'settled' | 'cancelled' | 'expired';
  settleTxHash?: string;
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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch order status: ${res.status}`);
    return res.json();
  },

  async getOrderbook(
    pair: string,
    relayerUrl?: string,
  ): Promise<any[]> {
    const url = `${relayerUrl || this.getBaseUrl()}/api/orderbook/${pair}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch orderbook: ${res.status}`);
    return res.json();
  },

  async healthCheck(relayerUrl?: string): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${relayerUrl || this.getBaseUrl()}/health`, {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  /**
   * Fetch the relayer's Ethereum address and fee from /api/info.
   * Returns null if the endpoint is unreachable or the response is malformed.
   */
  async getRelayerInfo(relayerUrl?: string): Promise<RelayerInfo | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${relayerUrl || this.getBaseUrl()}/api/info`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.address) return null;
      return {
        address: data.address as string,
        url: relayerUrl || this.getBaseUrl(),
        fee: Number(data.fee ?? 0),
        active: true,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
