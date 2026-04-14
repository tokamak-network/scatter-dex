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
  maxFee: string;
  expiry: string;
  feeMode?: string;
  status: string;
  submittedAt: number;
  settleTxHash?: string;
  claims?: { claimHash: string; amount: string; releaseDelay: string }[];
}

export interface OrderHistoryResponse {
  orders: RelayerOrder[];
  total: number;
  limit: number;
  offset: number;
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

  async submitOrder(order: OrderData, signature: string, feeMode?: "cover_taker"): Promise<{ status: string; txHash?: string; nonce?: string }> {
    const res = await fetch(`${this.baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, signature, ...(feeMode && { feeMode }) }),
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

  async getOrderHistory(address: string, opts: { status?: string; limit?: number; offset?: number } = {}): Promise<OrderHistoryResponse> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    params.set("limit", String(opts.limit ?? 50));
    params.set("offset", String(opts.offset ?? 0));
    const res = await fetch(`${this.baseUrl}/api/orders/${address}?${params}`);
    if (!res.ok) throw new Error(`Failed to get order history: ${res.statusText}`);
    return res.json();
  }

  async getOrderDetail(address: string, nonce: string): Promise<RelayerOrder> {
    const res = await fetch(`${this.baseUrl}/api/orders/${address}/${nonce}`);
    if (!res.ok) throw new Error(`Failed to get order detail: ${res.statusText}`);
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
    const res = await fetch(`${this.baseUrl}/api/private-orderbook/${pair}`);
    if (!res.ok) throw new Error(`Failed to get orderbook: ${res.statusText}`);
    return res.json();
  }
}
