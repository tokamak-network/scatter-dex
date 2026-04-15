import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import express from "express";
import cors from "cors";
import { Wallet } from "ethers";
import fs from "fs";
import { OrderbookDB } from "../src/core/db.js";
import { createSettlementRoutes, createSettlementStatsRoutes } from "../src/routes/settlements.js";
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
    app.use("/api/settlements", createSettlementRoutes(db, noopLimiter, noopLimiter));
    app.use("/api", createSettlementStatsRoutes(db, noopLimiter));
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

  // ─── Phase 2.5c: read APIs ───────────────────────────────────────

  async function get(path: string) {
    const res = await fetch(`http://localhost:${PORT}${path}`);
    return { status: res.status, body: await res.json() };
  }

  it("GET /api/settlements returns rows with relayer + pair + since filters", async () => {
    const tA = "0x" + "11".repeat(20);
    const tB = "0x" + "22".repeat(20);
    await post(basePayload({ txHash: "0x" + "aa".repeat(32), sellToken: tA, buyToken: tB }), makerW);
    await post(basePayload({ txHash: "0x" + "bb".repeat(32), sellToken: tB, buyToken: tA }), makerW);

    const all = await get("/api/settlements");
    expect(all.status).toBe(200);
    expect(all.body.count).toBe(2);
    expect(all.body.settlements[0].verified).toBe(false);

    const filtered = await get(`/api/settlements?relayer=${makerW.address}&pair=${tA}-${tB}`);
    expect(filtered.body.count).toBe(2);
  });

  it("GET /api/settlements rejects bad relayer / pair / since with 400", async () => {
    expect((await get("/api/settlements?relayer=notanaddress")).status).toBe(400);
    expect((await get("/api/settlements?pair=foo")).status).toBe(400);
    expect((await get("/api/settlements?since=-1")).status).toBe(400);
    expect((await get("/api/settlements?since=12.5")).status).toBe(400);
  });

  it("GET /api/relayers/:addr/stats aggregates txCount + volumeByToken + pairs + avgFeeBps", async () => {
    const tA = "0x" + "11".repeat(20);
    const tB = "0x" + "22".repeat(20);
    // Three trades by maker A, all on pair (tA, tB), each side fee=100, buy=2000, cap=30
    await post(basePayload({ txHash: "0x" + "11".repeat(32), sellToken: tA, buyToken: tB }), makerW);
    await post(basePayload({ txHash: "0x" + "22".repeat(32), sellToken: tA, buyToken: tB }), makerW);
    await post(basePayload({ txHash: "0x" + "33".repeat(32), sellToken: tB, buyToken: tA }), makerW);

    const r = await get(`/api/relayers/${makerW.address}/stats`);
    expect(r.status).toBe(200);
    expect(r.body.address).toBe(makerW.address.toLowerCase());
    expect(r.body.txCount).toBe(3);
    expect(r.body.txCountVerified).toBe(0);
    expect(r.body.volumeByToken.length).toBe(2);
    // Pair counts: 2× (tA→tB) + 1× (tB→tA) → 2 distinct directional pairs
    expect(r.body.pairs.length).toBe(2);
    // Each side contributes fee=100 / buy=2000 = 500 bps; both sides per row,
    // 3 rows = 6 contributions, average = 500.
    expect(r.body.avgFeeBps).toBeCloseTo(500, 0);
    // Pre-2.5b: nothing verified yet, so successRate is null (not 0) so the
    // dashboard can distinguish "no data" from "0% success".
    expect(r.body.successRate).toBeNull();
    // lastSettleAt now falls back to created_at on unverified rows so it's
    // useful in the pre-verify window — should be a recent unix-seconds value.
    expect(r.body.lastSettleAt).toBeGreaterThan(0);
  });

  it("GET /api/relayers/:addr/stats returns zeros for an unknown address", async () => {
    const r = await get("/api/relayers/0x" + "ff".repeat(20) + "/stats");
    expect(r.status).toBe(200);
    expect(r.body.txCount).toBe(0);
    expect(r.body.volumeByToken).toEqual([]);
    expect(r.body.pairs).toEqual([]);
    expect(r.body.avgFeeBps).toBeNull();
    expect(r.body.successRate).toBeNull();
  });

  it("GET /api/relayers/:addr/stats rejects bad address with 400", async () => {
    const r = await get("/api/relayers/notanaddress/stats");
    expect(r.status).toBe(400);
  });

  it("GET /api/network/totals counts rows + active pairs + active relayers", async () => {
    const tA = "0x" + "11".repeat(20);
    const tB = "0x" + "22".repeat(20);
    await post(basePayload({ txHash: "0x" + "aa".repeat(32), sellToken: tA, buyToken: tB }), makerW);
    await post(
      basePayload({
        txHash: "0x" + "bb".repeat(32),
        sellToken: tA,
        buyToken: tB,
        makerRelayer: outsiderW.address,
        takerRelayer: outsiderW.address,
      }),
      outsiderW,
    );

    const r = await get("/api/network/totals");
    expect(r.status).toBe(200);
    expect(r.body.txCount).toBe(2);
    // activePairs uses MIN/MAX normalisation so both (A→B) and (B→A)
    // collapse onto a single pair, matching the unordered semantics on
    // the read filter side.
    expect(r.body.activePairs).toBe(1); // only (tA, tB)
    // makerW (submitter+maker), takerW (taker on row 1), outsiderW (all roles on row 2)
    expect(r.body.activeRelayers).toBe(3);
    // Falls back to created_at on unverified rows.
    expect(r.body.lastSettleAt).toBeGreaterThan(0);
  });

  it("GET /api/network/totals applies since filter", async () => {
    await post(basePayload({ txHash: "0x" + "11".repeat(32) }), makerW);
    // since far in the future → 0 rows
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const r = await get(`/api/network/totals?since=${future}`);
    expect(r.body.txCount).toBe(0);
  });
});
