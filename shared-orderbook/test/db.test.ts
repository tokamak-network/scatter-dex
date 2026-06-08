import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { OrderbookDB } from "../src/core/db.js";
import type { OrderSummary } from "../src/types/order.js";
import fs from "fs";

const TEST_DB = "/tmp/shared-orderbook-test.db";

function makeOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: overrides.id ?? "0xrelayer1-1",
    chainId: overrides.chainId,
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
    const orders = db.listOpen(11155111);
    expect(orders).toHaveLength(2);
  });

  it("lists by pair (both directions)", () => {
    const tokenA = "0x" + "a".repeat(40);
    const tokenB = "0x" + "b".repeat(40);

    db.insertOrder(makeOrder({ id: "r1-1", sellToken: tokenA, buyToken: tokenB }));
    db.insertOrder(makeOrder({ id: "r2-1", sellToken: tokenB, buyToken: tokenA }));

    // Both orders should appear regardless of query direction
    const orders = db.listByPair(11155111, tokenA, tokenB);
    expect(orders).toHaveLength(2);
  });

  it("lists by relayer", () => {
    db.insertOrder(makeOrder({ id: "r1-1", relayer: "0xrelayer1" }));
    db.insertOrder(makeOrder({ id: "r2-1", relayer: "0xrelayer2" }));

    const orders = db.listByRelayer(11155111, "0xrelayer1");
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
    expect(db.countByRelayer(11155111, "0xrelayer1")).toBe(2);
  });

  it("isolates orders by chainId (multitenancy)", () => {
    // Same relayer + pair on two networks. Reads scoped to one chain must
    // never surface the other's rows.
    db.insertOrder(makeOrder({ id: "sep-1", chainId: 11155111, relayer: "0xrelayer1" }));
    db.insertOrder(makeOrder({ id: "main-1", chainId: 1, relayer: "0xrelayer1" }));
    db.insertOrder(makeOrder({ id: "main-2", chainId: 1, relayer: "0xrelayer1" }));

    expect(db.listOpen(11155111).map((o) => o.order.id)).toEqual(["sep-1"]);
    expect(db.listOpen(1).map((o) => o.order.id).sort()).toEqual(["main-1", "main-2"]);
    expect(db.getOrder("sep-1")!.order.chainId).toBe(11155111);
    expect(db.getOrder("main-1")!.order.chainId).toBe(1);

    expect(db.countByRelayer(11155111, "0xrelayer1")).toBe(1);
    expect(db.countByRelayer(1, "0xrelayer1")).toBe(2);

    const tokenA = "0x" + "a".repeat(40);
    const tokenB = "0x" + "b".repeat(40);
    expect(db.listByPair(1, tokenA, tokenB)).toHaveLength(2);
    expect(db.listByPair(11155111, tokenA, tokenB)).toHaveLength(1);
  });

  it("defaults a chainId-less order to Sepolia (backward compatibility)", () => {
    db.insertOrder(makeOrder({ id: "legacy-1" })); // no chainId on the wire
    expect(db.getOrder("legacy-1")!.order.chainId).toBe(11155111);
    expect(db.listOpen(11155111).map((o) => o.order.id)).toContain("legacy-1");
    expect(db.listOpen(1)).toHaveLength(0);
  });

  it("migrates a legacy (pre-chain_id) DB without failing on the chain_id indexes", () => {
    // Regression: createTables() builds chain_id-leading indexes, which would
    // throw "no such column: chain_id" on a legacy DB unless the ALTER runs
    // first. Seed an old-schema orders table with a row, then open it.
    const LEGACY_DB = "/tmp/shared-orderbook-legacy-test.db";
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(LEGACY_DB + suffix); } catch {} }
    const raw = new Database(LEGACY_DB);
    raw.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY, relayer TEXT NOT NULL, relayer_url TEXT NOT NULL,
        sell_token TEXT NOT NULL, buy_token TEXT NOT NULL,
        sell_amount TEXT NOT NULL, buy_amount TEXT NOT NULL,
        min_fill_amount TEXT NOT NULL DEFAULT '0', max_fee INTEGER NOT NULL,
        expiry INTEGER NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', match_id TEXT
      );
    `);
    raw.prepare(
      `INSERT INTO orders (id, relayer, relayer_url, sell_token, buy_token, sell_amount, buy_amount, max_fee, expiry, created_at)
       VALUES ('legacy', '0xr', 'http://x', '0xa', '0xb', '1', '2', 30, 9999999999, 1)`,
    ).run();
    raw.close();

    // Opening must not throw (the migration runs before the indexes).
    const migrated = new OrderbookDB(LEGACY_DB);
    // The pre-existing row is backfilled to Sepolia and stays queryable.
    expect(migrated.getOrder("legacy")!.order.chainId).toBe(11155111);
    expect(migrated.listOpen(11155111).map((o) => o.order.id)).toContain("legacy");
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(LEGACY_DB + suffix); } catch {} }
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
