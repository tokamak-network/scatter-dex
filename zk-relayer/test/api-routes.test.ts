/**
 * [R-13] HTTP-level API route tests using supertest.
 *
 * Tests cover: status codes, error responses, rate limiting headers,
 * content types, and input validation for the main public endpoints.
 * Admin and auth-protected endpoints are tested with correct/missing keys.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";

// ─── Mock config before importing routes ────────────────────────
vi.mock("../src/config.js", () => ({
  config: {
    rpcUrl: "http://localhost:8545",
    rpcUrlsFallback: [],
    relayerPrivateKey: "0x" + "ab".repeat(32),
    commitmentPoolAddress: "0x" + "11".repeat(20),
    privateSettlementAddress: "0x" + "22".repeat(20),
    feeVaultAddress: "0x" + "33".repeat(20),
    adminApiKey: Buffer.from("a]".repeat(16) + "b]".repeat(16)),
    relayerFee: 30,
    port: 3999,
    sharedOrderbookUrl: null,
    relayerPublicUrl: null,
    maxGasPriceGwei: 100,
  },
  updateRelayerFee: vi.fn(),
}));

// Mock metrics to avoid side effects
vi.mock("../src/core/metrics.js", () => ({
  recordOrderSubmitted: vi.fn(),
  recordSettlement: vi.fn(),
  recordTradeOffer: vi.fn(),
  recordP2POrderReceived: vi.fn(),
  getMetrics: vi.fn(() => ({
    orderSubmitted: 0,
    settlementSuccess: 0,
    settlementFailed: 0,
    tradeOfferSent: 0,
    tradeOfferReceived: 0,
    p2pOrderReceived: 0,
  })),
}));

import { createOrderbookRoutes } from "../src/routes/orderbook.js";
import { createInfoRoutes } from "../src/routes/info.js";
import { PrivateOrderbook } from "../src/core/orderbook.js";

// ─── Minimal mock submitter ─────────────────────────────────────
function mockSubmitter(): any {
  return {
    getAddress: () => "0x" + "aa".repeat(20),
    getWallet: () => ({ address: "0x" + "aa".repeat(20) }),
    getProvider: () => ({
      getBlockNumber: async () => 42,
      getBalance: async () => 1000000000000000000n,
    }),
    getCommitmentMerkleProof: async (idx: number) => ({
      root: "0x01",
      pathElements: [],
      pathIndices: [],
      leafIndex: idx,
    }),
  };
}

function mockDB(): any {
  const meta = new Map<string, string>();
  return {
    setMeta: (k: string, v: string) => meta.set(k, v),
    getMeta: (k: string) => meta.get(k) ?? null,
    getRelayerStats: () => ({ totalSettled: 0, totalFees: "0", avgGasUsed: 0 }),
  };
}

// ─── Orderbook routes ───────────────────────────────────────────

describe("GET /api/private-orderbook", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    const book = new PrivateOrderbook();
    app.use("/api/private-orderbook", createOrderbookRoutes(book));
  });

  it("returns 200 with totalOrders", async () => {
    const res = await request(app).get("/api/private-orderbook");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalOrders", 0);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});

// ─── Info routes ────────────────────────────────────────────────

describe("GET /api/info", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    const book = new PrivateOrderbook();
    const sub = mockSubmitter();
    app.use("/api/info", createInfoRoutes(book, sub));
  });

  it("returns 200 with relayer metadata", async () => {
    const res = await request(app).get("/api/info");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("name", "ScatterDEX ZK Relayer");
    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("address");
    expect(res.body).toHaveProperty("fee", 30);
    expect(res.body).toHaveProperty("commitmentPool");
    expect(res.body).toHaveProperty("privateSettlement");
  });

  it("GET /api/info/merkle-proof returns 400 without leafIndex", async () => {
    const res = await request(app).get("/api/info/merkle-proof");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/info/merkle-proof returns 400 for negative index", async () => {
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=-1");
    expect(res.status).toBe(400);
  });

  it("GET /api/info/merkle-proof returns 200 for valid index", async () => {
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=0");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("root");
  });
});

// ─── Rate limiting ──────────────────────────────────────────────

describe("Rate limiting", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    const limiter = rateLimit({
      windowMs: 60_000,
      max: 2,
      message: { error: "too many requests" },
    });
    const book = new PrivateOrderbook();
    app.use("/api/private-orderbook", limiter, createOrderbookRoutes(book));
  });

  it("returns 429 after exceeding rate limit", async () => {
    await request(app).get("/api/private-orderbook").expect(200);
    await request(app).get("/api/private-orderbook").expect(200);
    const res = await request(app).get("/api/private-orderbook");
    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty("error", "too many requests");
  });
});

// ─── Authorize orders ───────────────────────────────────────────

describe("POST /api/authorize-orders", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = express();
    app.use(express.json({ limit: "10kb" }));
    const { createAuthorizeOrderRoutes } = await import("../src/routes/authorize-orders.js");
    const sub = {
      getAddress: () => "0x" + "aa".repeat(20),
      setDB: vi.fn(),
    } as any;
    app.use("/api/authorize-orders", createAuthorizeOrderRoutes(sub, undefined, sub.getAddress()));
  });

  it("returns 400 for empty body", async () => {
    const res = await request(app).post("/api/authorize-orders").send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for missing publicSignals", async () => {
    const res = await request(app)
      .post("/api/authorize-orders")
      .send({ proof: {}, publicSignalsArray: [] });
    expect(res.status).toBe(400);
  });

  it("GET /:nullifier returns 404 for unknown", async () => {
    const res = await request(app).get("/api/authorize-orders/0xdeadbeef");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "Order not found");
  });

  it("DELETE /:nullifier returns 501 (disabled)", async () => {
    const res = await request(app).delete("/api/authorize-orders/0xdeadbeef");
    expect(res.status).toBe(501);
  });
});

// ─── Admin routes ───────────────────────────────────────────────

describe("Admin API", () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createAdminRoutes } = await import("../src/routes/admin.js");
    app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRoutes({
      submitter: mockSubmitter(),
      db: mockDB(),
      orderbook: new PrivateOrderbook(),
      drainAuthorizeOrders: () => 0,
      getAuthorizeOrderStats: () => ({ pending: 0, matched: 0, total: 0 }),
    }));
  });

  it("rejects requests without x-admin-key", async () => {
    const res = await request(app).get("/api/admin/status");
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong x-admin-key", async () => {
    const res = await request(app)
      .get("/api/admin/status")
      .set("x-admin-key", "wrong-key");
    expect(res.status).toBe(401);
  });

  it("PUT /fee rejects missing bps", async () => {
    const key = "a]".repeat(16) + "b]".repeat(16);
    const res = await request(app)
      .put("/api/admin/fee")
      .set("x-admin-key", key)
      .send({});
    expect(res.status).toBe(400);
  });

  it("PUT /fee rejects bps > 10000", async () => {
    const key = "a]".repeat(16) + "b]".repeat(16);
    const res = await request(app)
      .put("/api/admin/fee")
      .set("x-admin-key", key)
      .send({ bps: 10001 });
    expect(res.status).toBe(400);
  });

  it("POST /pause returns 200", async () => {
    const key = "a]".repeat(16) + "b]".repeat(16);
    const res = await request(app)
      .post("/api/admin/pause")
      .set("x-admin-key", key);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "paused");
  });

  it("POST /resume returns 200", async () => {
    const key = "a]".repeat(16) + "b]".repeat(16);
    const res = await request(app)
      .post("/api/admin/resume")
      .set("x-admin-key", key);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "resumed");
  });
});

// ─── Body size limit ────────────────────────────────────────────

describe("Body size limit", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json({ limit: "1kb" }));
    app.post("/test", (_req, res) => res.json({ ok: true }));
  });

  it("rejects oversized JSON body with 413", async () => {
    const largeBody = { data: "x".repeat(2000) };
    const res = await request(app)
      .post("/test")
      .send(largeBody);
    expect(res.status).toBe(413);
  });
});
