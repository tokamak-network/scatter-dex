export class RelayerClient {
  constructor(private baseUrl: string) {}

  async getInfo() {
    const res = await fetch(`${this.baseUrl}/api/info`);
    if (!res.ok) throw new Error(`info: ${res.statusText}`);
    return res.json();
  }

  async submitOrder(order: any, signature: string) {
    const res = await fetch(`${this.baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, signature }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  async getOrders(address: string) {
    const res = await fetch(`${this.baseUrl}/api/orders/${address}`);
    if (!res.ok) throw new Error(`orders: ${res.statusText}`);
    return res.json();
  }

  async cancelOrder(address: string, nonce: number, signature: string) {
    const res = await fetch(`${this.baseUrl}/api/orders/${address}/${nonce}`, {
      method: "DELETE",
      headers: { "x-cancel-signature": signature },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  async getOrderbook(pair: string) {
    const res = await fetch(`${this.baseUrl}/api/orderbook/${pair}`);
    if (!res.ok) throw new Error(`orderbook: ${res.statusText}`);
    return res.json();
  }
}
