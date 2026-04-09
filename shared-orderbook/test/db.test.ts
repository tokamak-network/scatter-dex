import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OrderbookDB } from "../src/core/db.js";
import type { OrderSummary } from "../src/types/order.js";
import fs from "fs";

const TEST_DB = "/tmp/shared-orderbook-test.db";

function makeOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: overrides.id ?? "0xrelayer1-1",
    relayer: overrides.relayer ?? "0xrelayer1",
    relayerUrl: overrides.relayerUrl ?? "http://localhost:3002",
    nonce: overrides.nonce ?? "1",
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

describe("OrderbookDB", () => {
  let db: OrderbookDB;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
    try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
    db = new OrderbookDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
    try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("inserts and retrieves an order", () => {
    const order = makeOrder();
    db.insertOrder(order);
    const stored = db.getOrder(order.id);
    expect(stored).not.toBeNull();
    expect(stored!.order.sellAmount).toBe("1000000000000000000");
    expect(stored!.status).toBe("open");
  });

  it("lists open orders", () => {
    db.insertOrder(makeOrder({ id: "r1-1" }));
    db.insertOrder(makeOrder({ id: "r1-2" }));
    const orders = db.listOpen();
    expect(orders).toHaveLength(2);
  });

  it("lists by pair (both directions)", () => {
    const tokenA = "0x" + "a".repeat(40);
    const tokenB = "0x" + "b".repeat(40);

    db.insertOrder(makeOrder({ id: "r1-1", sellToken: tokenA, buyToken: tokenB }));
    db.insertOrder(makeOrder({ id: "r2-1", sellToken: tokenB, buyToken: tokenA }));

    // Both orders should appear regardless of query direction
    const orders = db.listByPair(tokenA, tokenB);
    expect(orders).toHaveLength(2);
  });

  it("lists by relayer", () => {
    db.insertOrder(makeOrder({ id: "r1-1", relayer: "0xrelayer1" }));
    db.insertOrder(makeOrder({ id: "r2-1", relayer: "0xrelayer2" }));

    const orders = db.listByRelayer("0xrelayer1");
    expect(orders).toHaveLength(1);
    expect(orders[0].order.relayer).toBe("0xrelayer1");
  });

  it("updates status", () => {
    db.insertOrder(makeOrder({ id: "r1-1" }));
    db.updateStatus("r1-1", "cancelled");
    const stored = db.getOrder("r1-1");
    expect(stored!.status).toBe("cancelled");
  });

  it("counts by relayer", () => {
    db.insertOrder(makeOrder({ id: "r1-1", relayer: "0xrelayer1" }));
    db.insertOrder(makeOrder({ id: "r1-2", relayer: "0xrelayer1" }));
    expect(db.countByRelayer("0xrelayer1")).toBe(2);
  });

  it("purges expired orders", () => {
    db.insertOrder(makeOrder({
      id: "expired-1",
      expiry: Math.floor(Date.now() / 1000) - 100,
    }));
    db.insertOrder(makeOrder({ id: "active-1" }));

    const purged = db.purgeExpired();
    expect(purged).toBe(1);

    const expired = db.getOrder("expired-1");
    expect(expired!.status).toBe("expired");

    const active = db.getOrder("active-1");
    expect(active!.status).toBe("open");
  });

  it("loads all open orders", () => {
    db.insertOrder(makeOrder({ id: "r1-1" }));
    db.insertOrder(makeOrder({ id: "r1-2" }));
    db.updateStatus("r1-2", "cancelled");

    const open = db.loadAllOpen();
    expect(open).toHaveLength(1);
    expect(open[0].order.id).toBe("r1-1");
  });

  it("records a match atomically", () => {
    const maker = makeOrder({ id: "maker-1", relayer: "0xrelayer1" });
    const taker = makeOrder({ id: "taker-1", relayer: "0xrelayer2" });
    db.insertOrder(maker);
    db.insertOrder(taker);

    db.recordMatch({
      matchId: "match-001",
      maker,
      taker,
      settlingRelayer: "0xrelayer1",
      pair: "0x" + "a".repeat(40) + "-0x" + "b".repeat(40),
      price: "2000000000000000000",
      createdAt: Math.floor(Date.now() / 1000),
    });

    expect(db.getOrder("maker-1")!.status).toBe("matched");
    expect(db.getOrder("taker-1")!.status).toBe("matched");

    const match = db.getMatch("match-001");
    expect(match).not.toBeNull();
    expect(match!.settlingRelayer).toBe("0xrelayer1");
  });
});
