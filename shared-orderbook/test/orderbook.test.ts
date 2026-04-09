import { describe, it, expect, beforeEach } from "vitest";
import { SharedOrderbook } from "../src/core/orderbook.js";
import type { OrderSummary } from "../src/types/order.js";

function makeOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: overrides.id ?? "0xrelayer1-1",
    relayer: overrides.relayer ?? "0xrelayer1",
    relayerUrl: overrides.relayerUrl ?? "http://localhost:3002",
    nonce: overrides.nonce ?? "1",
    pubKeyAx: overrides.pubKeyAx ?? "12345",
    sellToken: overrides.sellToken ?? "0x" + "a".repeat(40),
    buyToken: overrides.buyToken ?? "0x" + "b".repeat(40),
    sellAmount: overrides.sellAmount ?? "1000000000000000000",
    buyAmount: overrides.buyAmount ?? "2000000000000000000",
    minFillAmount: overrides.minFillAmount ?? "0",
    maxFee: overrides.maxFee ?? 30,
    expiry: overrides.expiry ?? Math.floor(Date.now() / 1000) + 3600,
    createdAt: overrides.createdAt ?? Math.floor(Date.now() / 1000),
  };
}

describe("SharedOrderbook", () => {
  let ob: SharedOrderbook;

  beforeEach(() => {
    ob = new SharedOrderbook();
  });

  describe("relayer registry", () => {
    it("registers a relayer", () => {
      const info = ob.registerRelayer("0xABC", "http://localhost:3002", "test-relayer");
      expect(info.address).toBe("0xabc");
      expect(info.url).toBe("http://localhost:3002");
      expect(info.name).toBe("test-relayer");
    });

    it("heartbeat updates timestamp", () => {
      ob.registerRelayer("0xABC", "http://localhost:3002");
      const ok = ob.heartbeat("0xABC");
      expect(ok).toBe(true);
    });

    it("heartbeat fails for unregistered relayer", () => {
      const ok = ob.heartbeat("0xUNKNOWN");
      expect(ok).toBe(false);
    });

    it("lists active relayers", () => {
      ob.registerRelayer("0xa", "http://a.example.com");
      ob.registerRelayer("0xb", "http://b.example.com");
      expect(ob.getActiveRelayers()).toHaveLength(2);
    });
  });

  describe("order management", () => {
    it("adds and retrieves an order", () => {
      const order = makeOrder();
      ob.addOrder(order);
      const stored = ob.getOrder(order.id);
      expect(stored).toBeDefined();
      expect(stored!.status).toBe("open");
      expect(stored!.order.sellAmount).toBe("1000000000000000000");
    });

    it("rejects duplicate order id", () => {
      const order = makeOrder();
      ob.addOrder(order);
      expect(() => ob.addOrder(order)).toThrow("duplicate order id");
    });

    it("removes an order", () => {
      const order = makeOrder();
      ob.addOrder(order);
      const removed = ob.removeOrder(order.id);
      expect(removed).toBe(true);
      expect(ob.getOrder(order.id)).toBeUndefined();
      expect(ob.size).toBe(0);
    });

    it("lists open orders", () => {
      ob.addOrder(makeOrder({ id: "r1-1" }));
      ob.addOrder(makeOrder({ id: "r1-2" }));
      expect(ob.listOpen()).toHaveLength(2);
    });

    it("lists orders by pair", () => {
      const tokenA = "0x" + "a".repeat(40);
      const tokenB = "0x" + "b".repeat(40);
      const tokenC = "0x" + "c".repeat(40);

      ob.addOrder(makeOrder({ id: "r1-1", sellToken: tokenA, buyToken: tokenB }));
      ob.addOrder(makeOrder({ id: "r1-2", sellToken: tokenA, buyToken: tokenC }));

      const pair = tokenA < tokenB ? `${tokenA}-${tokenB}` : `${tokenB}-${tokenA}`;
      const orders = ob.listOpen(pair);
      expect(orders).toHaveLength(1);
    });
  });

  describe("counterparty matching", () => {
    it("finds counterparty orders on opposite side", () => {
      const tokenA = "0x" + "a".repeat(40);
      const tokenB = "0x" + "b".repeat(40);

      // Sell A, Buy B (sell side since a < b)
      const sellOrder = makeOrder({
        id: "r1-1",
        relayer: "0xrelayer1",
        sellToken: tokenA,
        buyToken: tokenB,
      });

      // Sell B, Buy A (buy side)
      const buyOrder = makeOrder({
        id: "r2-1",
        relayer: "0xrelayer2",
        sellToken: tokenB,
        buyToken: tokenA,
      });

      ob.addOrder(sellOrder);
      ob.addOrder(buyOrder);

      // Counterparties for the sell order should be on buy side
      const counters = ob.getCounterpartyOrders(sellOrder);
      expect(counters).toHaveLength(1);
      expect(counters[0].order.id).toBe("r2-1");
    });

    it("returns empty for no counterparties", () => {
      const order = makeOrder();
      ob.addOrder(order);
      const counters = ob.getCounterpartyOrders(order);
      expect(counters).toHaveLength(0);
    });
  });

  describe("expiry and cleanup", () => {
    it("purges expired orders", () => {
      const expired = makeOrder({
        id: "r1-expired",
        expiry: Math.floor(Date.now() / 1000) - 100,
      });
      ob.addOrder(expired);
      const expiredIds = ob.purgeExpired();
      expect(expiredIds).toHaveLength(1);
      expect(expiredIds[0]).toBe("r1-expired");
      expect(ob.getOrder("r1-expired")!.status).toBe("expired");
    });

    it("purges stale relayers and their orders", () => {
      // Register relayer with old heartbeat
      ob.registerRelayer("0xstale", "http://stale.example.com");
      const info = ob.getRelayer("0xstale")!;
      info.lastHeartbeat = Math.floor(Date.now() / 1000) - 9999;

      ob.addOrder(makeOrder({ id: "0xstale-1", relayer: "0xstale" }));

      const stale = ob.purgeStaleRelayers(600);
      expect(stale).toContain("0xstale");
      expect(ob.getOrder("0xstale-1")!.status).toBe("expired");
    });
  });

  describe("stats", () => {
    it("returns correct stats", () => {
      ob.registerRelayer("0xr1", "http://r1.example.com");
      ob.addOrder(makeOrder({ id: "r1-1" }));
      ob.addOrder(makeOrder({ id: "r1-2" }));

      const stats = ob.getStats();
      expect(stats.totalOrders).toBe(2);
      expect(stats.relayers).toBe(1);
      expect(stats.pairs).toBe(1);
    });
  });
});
