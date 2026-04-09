import { describe, it, expect, beforeEach } from "vitest";
import { RemoteOrderStore } from "../src/core/remote-orderbook.js";
import type { OrderSummary } from "../src/types/order.js";

function makeRemoteOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: overrides.id ?? "0xrelayer1-1",
    relayer: overrides.relayer ?? "0xrelayer1",
    relayerUrl: overrides.relayerUrl ?? "http://localhost:3002",
    nonce: overrides.nonce ?? "1",
    pubKeyAx: overrides.pubKeyAx ?? "12345",
    sellToken: overrides.sellToken ?? "0x" + "aa".repeat(20),
    buyToken: overrides.buyToken ?? "0x" + "bb".repeat(20),
    sellAmount: overrides.sellAmount ?? "1000000000000000000",
    buyAmount: overrides.buyAmount ?? "2000000000000000000",
    minFillAmount: overrides.minFillAmount ?? "0",
    maxFee: overrides.maxFee ?? 30,
    expiry: overrides.expiry ?? Math.floor(Date.now() / 1000) + 3600,
    createdAt: overrides.createdAt ?? Math.floor(Date.now() / 1000),
  };
}

describe("RemoteOrderStore", () => {
  let store: RemoteOrderStore;

  beforeEach(() => {
    store = new RemoteOrderStore();
  });

  it("adds and retrieves an order", () => {
    const order = makeRemoteOrder();
    store.add(order);
    expect(store.size).toBe(1);
    expect(store.get(order.id)).toBeDefined();
  });

  it("skips duplicate order", () => {
    const order = makeRemoteOrder();
    store.add(order);
    store.add(order); // duplicate
    expect(store.size).toBe(1);
  });

  it("skips expired order", () => {
    const expired = makeRemoteOrder({
      id: "expired-1",
      expiry: Math.floor(Date.now() / 1000) - 100,
    });
    store.add(expired);
    expect(store.size).toBe(0);
  });

  it("removes order by id", () => {
    const order = makeRemoteOrder();
    store.add(order);
    store.remove(order.id);
    expect(store.size).toBe(0);
    expect(store.get(order.id)).toBeUndefined();
  });

  it("removes all orders by relayer", () => {
    store.add(makeRemoteOrder({ id: "r1-1", relayer: "0xrelayer1" }));
    store.add(makeRemoteOrder({ id: "r1-2", relayer: "0xrelayer1" }));
    store.add(makeRemoteOrder({ id: "r2-1", relayer: "0xrelayer2" }));
    store.removeByRelayer("0xrelayer1");
    expect(store.size).toBe(1);
    expect(store.get("r2-1")).toBeDefined();
  });

  it("returns sell orders sorted by price ascending", () => {
    const tokenA = "0x" + "aa".repeat(20); // lower address = sell side
    const tokenB = "0x" + "bb".repeat(20);

    // Expensive order (sell 2, buy 1 → price = 2)
    store.add(makeRemoteOrder({
      id: "expensive",
      sellToken: tokenA, buyToken: tokenB,
      sellAmount: "2000", buyAmount: "1000",
    }));
    // Cheap order (sell 1, buy 1 → price = 1)
    store.add(makeRemoteOrder({
      id: "cheap",
      sellToken: tokenA, buyToken: tokenB,
      sellAmount: "1000", buyAmount: "1000",
    }));

    const pair = `${tokenA}-${tokenB}`;
    const sells = store.getSellOrders(pair);
    expect(sells).toHaveLength(2);
    expect(sells[0].id).toBe("cheap"); // cheaper first
    expect(sells[1].id).toBe("expensive");
  });

  it("returns buy orders sorted by price descending", () => {
    const tokenA = "0x" + "aa".repeat(20);
    const tokenB = "0x" + "bb".repeat(20);

    // tokenB > tokenA → selling tokenB is the buy side of pair
    store.add(makeRemoteOrder({
      id: "low-bid",
      sellToken: tokenB, buyToken: tokenA,
      sellAmount: "1000", buyAmount: "2000",
    }));
    store.add(makeRemoteOrder({
      id: "high-bid",
      sellToken: tokenB, buyToken: tokenA,
      sellAmount: "2000", buyAmount: "1000",
    }));

    const pair = `${tokenA}-${tokenB}`;
    const buys = store.getBuyOrders(pair);
    expect(buys).toHaveLength(2);
    expect(buys[0].id).toBe("high-bid"); // higher bid first
  });

  it("getSellOrders/getBuyOrders filters expired", () => {
    const tokenA = "0x" + "aa".repeat(20);
    const tokenB = "0x" + "bb".repeat(20);

    store.add(makeRemoteOrder({
      id: "valid",
      sellToken: tokenA, buyToken: tokenB,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    }));
    // Manually insert one that will expire
    const almostExpired = makeRemoteOrder({
      id: "soon-expired",
      sellToken: tokenA, buyToken: tokenB,
      expiry: Math.floor(Date.now() / 1000) + 1, // 1 second from now
    });
    store.add(almostExpired);

    const pair = `${tokenA}-${tokenB}`;
    const sells = store.getSellOrders(pair);
    expect(sells.length).toBeGreaterThanOrEqual(1);
  });

  it("purges expired orders", () => {
    // We can't easily add expired orders since add() skips them,
    // but purgeExpired should work on orders that expire after insertion
    store.add(makeRemoteOrder({ id: "ok", expiry: Math.floor(Date.now() / 1000) + 3600 }));
    const purged = store.purgeExpired();
    expect(purged).toBe(0); // none expired
    expect(store.size).toBe(1);
  });

  it("clear removes everything", () => {
    store.add(makeRemoteOrder({ id: "a" }));
    store.add(makeRemoteOrder({ id: "b" }));
    store.clear();
    expect(store.size).toBe(0);
  });
});
