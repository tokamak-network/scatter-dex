import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import express from "express";
import cors from "cors";
import { Wallet } from "ethers";
import fs from "fs";
import { OrderbookDB } from "../src/core/db.js";
import { createSettlementRoutes } from "../src/routes/settlements.js";
import type { SettlementInsert } from "../src/types/settlement.js";

const TEST_DB = "/tmp/shared-orderbook-settlements-test.db";
const PORT = 14571;

const makerW = new Wallet("0x" + "11".repeat(32));
const takerW = new Wallet("0x" + "22".repeat(32));
const outsiderW = new Wallet("0x" + "33".repeat(32));

async function authHeaders(wallet: Wallet, method: string, path: string, url = "http://localhost:" + PORT) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:${method.toUpperCase()}:${path}:${url}`;
  const signature = await wallet.signMessage(message);
  return {
    "x-relayer-address": wallet.address,
    "x-relayer-signature": signature,
    "x-relayer-timestamp": ts,
    "x-relayer-url": url,
    "Content-Type": "application/json",
  };
}

const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

function basePayload(overrides: Partial<SettlementInsert> = {}): SettlementInsert {
  return {
    txHash: "0x" + "ab".repeat(32),
    blockNumber: 1234,
    blockTime: 1700000000,
    makerRelayer: makerW.address,
    takerRelayer: takerW.address,
    makerNullifier: "1234567890",
    takerNullifier: "9876543210",
    feeMaker: "100",
    feeTaker: "100",
    userMaxFeeMaker: 30,
    userMaxFeeTaker: 30,
    sellToken: "0x" + "11".repeat(20),
    buyToken: "0x" + "22".repeat(20),
    sellAmount: "1000",
    buyAmount: "2000",
    ...overrides,
  };
}

describe("/api/settlements", () => {
  let server: http.Server;
  let db: OrderbookDB;

  beforeAll(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    db = new OrderbookDB(TEST_DB);
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "10kb" }));
    app.use("/api/settlements", createSettlementRoutes(db, noopLimiter));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
    try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  beforeEach(() => {
    // Wipe between tests so PRIMARY KEY collisions on tx_hash don't bleed
    // across cases.
    db._resetSettlementsForTests();
  });

  async function post(body: unknown, signer: Wallet) {
    const headers = await authHeaders(signer, "POST", "/api/settlements");
    const res = await fetch(`http://localhost:${PORT}/api/settlements`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, body: json };
  }

  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/settlements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload()),
    });
    expect(res.status).toBe(401);
  });

  it("inserts a valid settlement and returns 201", async () => {
    const r = await post(basePayload(), makerW);
    expect(r.status).toBe(201);
    expect(r.body.inserted).toBe(true);
    expect(r.body.txHash).toBe("0x" + "ab".repeat(32));

    const stored = db.getSettlement("0x" + "ab".repeat(32));
    expect(stored).not.toBeNull();
    expect(stored!.submitter).toBe(makerW.address.toLowerCase());
    expect(stored!.makerRelayer).toBe(makerW.address.toLowerCase());
    expect(stored!.verified).toBe(false);
  });

  it("idempotent on duplicate tx_hash — returns 200 with inserted:false", async () => {
    await post(basePayload(), makerW);
    const r = await post(basePayload(), makerW);
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(false);
  });

  it("403 when submitter is neither maker nor taker (cannot claim others' trades)", async () => {
    const r = await post(basePayload(), outsiderW);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/maker|taker/i);
  });

  it("400 on missing required field (txHash)", async () => {
    const { txHash: _drop, ...partial } = basePayload();
    const r = await post(partial, makerW);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/txHash/);
  });

  it("400 on bad userMaxFeeMaker (out of range)", async () => {
    const r = await post(basePayload({ userMaxFeeMaker: 99999 }), makerW);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/userMaxFeeMaker/);
  });

  it("normalizes addresses to lowercase on storage", async () => {
    const upper = "0x" + "AB".repeat(20);
    await post(
      basePayload({
        txHash: "0x" + "cd".repeat(32),
        sellToken: upper,
        buyToken: upper,
      }),
      makerW,
    );
    const stored = db.getSettlement("0x" + "cd".repeat(32));
    expect(stored!.sellToken).toBe(upper.toLowerCase());
    expect(stored!.buyToken).toBe(upper.toLowerCase());
  });

  it("listSettlements filters by relayer (matches submitter or side)", async () => {
    await post(basePayload({ txHash: "0x" + "11".repeat(32) }), makerW);
    await post(basePayload({ txHash: "0x" + "22".repeat(32), takerRelayer: outsiderW.address }), makerW);
    // outsider posting their own trade
    await post(
      basePayload({
        txHash: "0x" + "33".repeat(32),
        makerRelayer: outsiderW.address,
        takerRelayer: outsiderW.address,
      }),
      outsiderW,
    );

    const all = db.listSettlements();
    expect(all.length).toBe(3);

    const onlyOutsider = db.listSettlements({ relayer: outsiderW.address });
    // outsider appears as taker in row #2 and as maker+taker+submitter in row #3
    expect(onlyOutsider.length).toBe(2);
  });

  it("listSettlements filters by pair (both directions)", async () => {
    const tA = "0x" + "11".repeat(20);
    const tB = "0x" + "22".repeat(20);
    await post(basePayload({ txHash: "0x" + "aa".repeat(32), sellToken: tA, buyToken: tB }), makerW);
    await post(basePayload({ txHash: "0x" + "bb".repeat(32), sellToken: tB, buyToken: tA }), makerW);

    const rows = db.listSettlements({ pair: [tA, tB] });
    expect(rows.length).toBe(2);
  });
});
