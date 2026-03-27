export interface RelayerInfo {
  name: string;
  version: string;
  address: string;
  fee: number;
  orderCount: number;
  settlement: string;
}

export interface RelayerOrder {
  maker: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  nonce: string;
  status: string;
  submittedAt: number;
  settleTxHash?: string;
}

export interface OrderData {
  maker: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: number;
  expiry: number;
  nonce: number;
  claims: { claimHash: string; amount: string; releaseDelay: number }[];
}

export interface OrderbookEntry {
  maker: string;
  sellAmount: string;
  buyAmount: string;
  nonce: string;
  expiry: number;
}

export class RelayerClient {
  constructor(private baseUrl: string) {}

  async getInfo(): Promise<RelayerInfo> {
    const res = await fetch(`${this.baseUrl}/api/info`);
    if (!res.ok) throw new Error(`Failed to get info: ${res.statusText}`);
    return res.json();
  }

  async submitOrder(order: OrderData, signature: string): Promise<{ status: string; txHash?: string; nonce?: string }> {
    const res = await fetch(`${this.baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, signature }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to submit order");
    }
    return res.json();
  }

  async getOrders(address: string): Promise<RelayerOrder[]> {
    const res = await fetch(`${this.baseUrl}/api/orders/${address}`);
    if (!res.ok) throw new Error(`Failed to get orders: ${res.statusText}`);
    return res.json();
  }

  async cancelOrder(address: string, nonce: number, signature: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/orders/${address}/${nonce}`, {
      method: "DELETE",
      headers: { "x-cancel-signature": signature },
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to cancel");
    }
  }

  async getOrderbook(pair: string): Promise<{ pair: string; sells: OrderbookEntry[]; buys: OrderbookEntry[] }> {
    const res = await fetch(`${this.baseUrl}/api/orderbook/${pair}`);
    if (!res.ok) throw new Error(`Failed to get orderbook: ${res.statusText}`);
    return res.json();
  }
}
