/**
 * E2E test — Full shared orderbook flow
 *
 * Simulates the Steam bot trading model end-to-end:
 * 1. Two relayers register with the shared orderbook server
 * 2. Relayer A posts a sell order (listing)
 * 3. Relayer B connects via WebSocket and receives the broadcast
 * 4. Relayer B posts a counterparty buy order
 * 5. Both relayers can see each other's orders
 * 6. Relayer B fetches peer list for P2P fallback
 * 7. Orders are cancelled and expired correctly
 * 8. Stats reflect the current state
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import cors from "cors";
import { Wallet } from "ethers";
import WebSocket from "ws";
import { SharedOrderbook } from "../src/core/orderbook.js";
import { OrderbookDB } from "../src/core/db.js";
import { OrderBroadcaster } from "../src/core/broadcaster.js";
import { createOrderRoutes } from "../src/routes/orders.js";
import { createRelayerRoutes } from "../src/routes/relayers.js";
import { createStatsRoutes } from "../src/routes/stats.js";
import { createPeerRoutes } from "../src/routes/peer.js";
import fs from "fs";

const TEST_DB = "/tmp/shared-orderbook-e2e.db";
const PORT = 14568;
const BASE = `http://localhost:${PORT}`;

// Deterministic wallets for two relayers
const relayerA = new Wallet("0x" + "a1".repeat(32));
const relayerB = new Wallet("0x" + "b2".repeat(32));

// Token addresses
const WETH = "0x" + "11".repeat(20);
const USDC = "0x" + "22".repeat(20);

const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

async function sign(wallet: Wallet, method: string, path: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const url = `http://relayer-${wallet.address.slice(2, 6)}.local:3002`;
  const msg = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:${method.toUpperCase()}:${path}:${url}`;
  const sig = await wallet.signMessage(msg);
  return {
    "x-relayer-address": wallet.address,
    "x-relayer-signature": sig,
    "x-relayer-timestamp": ts,
    "x-relayer-url": url,
    "Content-Type": "application/json",
  };
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function waitForWsMessage(ws: WebSocket, timeout = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS timeout")), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("E2E: Shared Orderbook Full Flow", () => {
  let server: http.Server;
  let db: OrderbookDB;
  let orderbook: SharedOrderbook;
  let broadcaster: OrderBroadcaster;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch {}
    }
    db = new OrderbookDB(TEST_DB);
    orderbook = new SharedOrderbook();
    broadcaster = new OrderBroadcaster();

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "10kb" }));
    app.use("/api/orders", createOrderRoutes(orderbook, db, broadcaster, noopLimiter, noopLimiter));
    app.use("/api/relayers", createRelayerRoutes(orderbook, broadcaster, noopLimiter, noopLimiter));
    app.use("/api/stats", createStatsRoutes(orderbook, noopLimiter));
    app.use("/api/peers", createPeerRoutes(orderbook, noopLimiter));
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    server = http.createServer(app);
    broadcaster.attach(server);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    broadcaster.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch {}
    }
  });

  // ─── Step 1: Health check ───

  it("server is up", async () => {
    const { status, body } = await api("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  // ─── Step 2: Relayer registration ───

  it("relayer A registers", async () => {
    const h = await sign(relayerA, "POST", "/api/relayers/register");
    const { status, body } = await api("/api/relayers/register", {
      method: "POST", headers: h, body: JSON.stringify({ name: "Relayer-A" }),
    });
    expect(status).toBe(200);
    expect(body.name).toBe("Relayer-A");
    expect(body.address).toBe(relayerA.address.toLowerCase());
  });

  it("relayer B registers", async () => {
    const h = await sign(relayerB, "POST", "/api/relayers/register");
    const { status, body } = await api("/api/relayers/register", {
      method: "POST", headers: h, body: JSON.stringify({ name: "Relayer-B" }),
    });
    expect(status).toBe(200);
    expect(body.name).toBe("Relayer-B");
  });

  it("both relayers appear in list", async () => {
    const { body } = await api("/api/relayers");
    expect(body.count).toBe(2);
  });

  // ─── Step 3: WebSocket subscription + order posting ───

  it("relayer B receives broadcast when relayer A posts order", async () => {
    // Relayer B connects via WebSocket
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/orders`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Relayer A posts a sell order: sell 1 WETH for 2000 USDC
    const msgPromise = waitForWsMessage(ws);
    const h = await sign(relayerA, "POST", "/api/orders");
    const { status } = await api("/api/orders", {
      method: "POST", headers: h,
      body: JSON.stringify({
        sellToken: WETH,
        buyToken: USDC,
        sellAmount: "1000000000000000000",   // 1 WETH
        buyAmount: "2000000000000",           // 2000 USDC (6 decimals)
        minFillAmount: "0",
        maxFee: 30,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        nonce: "100",
        pubKeyAx: "10001",
      }),
    });
    expect(status).toBe(201);

    // Relayer B should receive the broadcast
    const msg = await msgPromise;
    expect(msg.type).toBe("order:new");
    const order = msg.order as Record<string, unknown>;
    expect(order.relayer).toBe(relayerA.address.toLowerCase());
    expect(order.sellToken).toBe(WETH);
    expect(order.buyToken).toBe(USDC);
    expect(order.nonce).toBe("100");

    ws.close();
  });

  // ─── Step 4: Relayer B posts counterparty order ───

  it("relayer B posts counterparty order (buy WETH with USDC)", async () => {
    const h = await sign(relayerB, "POST", "/api/orders");
    const { status, body } = await api("/api/orders", {
      method: "POST", headers: h,
      body: JSON.stringify({
        sellToken: USDC,
        buyToken: WETH,
        sellAmount: "2000000000000",          // 2000 USDC
        buyAmount: "1000000000000000000",      // 1 WETH
        minFillAmount: "0",
        maxFee: 30,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        nonce: "200",
        pubKeyAx: "20001",
      }),
    });
    expect(status).toBe(201);
    expect(body.status).toBe("open");
  });

  // ─── Step 5: Both relayers see each other's orders ───

  it("lists all 2 open orders", async () => {
    const { body } = await api("/api/orders");
    expect(body.count).toBe(2);
    const orders = body.orders as Array<Record<string, unknown>>;
    const relayers = orders.map(o => o.relayer);
    expect(relayers).toContain(relayerA.address.toLowerCase());
    expect(relayers).toContain(relayerB.address.toLowerCase());
  });

  it("filters by pair (WETH-USDC)", async () => {
    const pair = WETH < USDC ? `${WETH}-${USDC}` : `${USDC}-${WETH}`;
    const { status, body } = await api(`/api/orders/${pair}`);
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    // Both sides of the pair appear
    const orders = body.orders as Array<Record<string, unknown>>;
    expect(orders.some(o => o.sellToken === WETH)).toBe(true);
    expect(orders.some(o => o.sellToken === USDC)).toBe(true);
  });

  it("invalid pair format returns 400", async () => {
    const { status } = await api("/api/orders/invalid-pair");
    expect(status).toBe(400);
  });

  // ─── Step 6: Stats ───

  it("stats shows 2 orders, 1 pair, 2 relayers", async () => {
    const { body } = await api("/api/stats");
    expect(body.totalOrders).toBe(2);
    expect(body.pairs).toBe(1);
    expect(body.relayers).toBe(2);
  });

  // ─── Step 7: Peer discovery for P2P fallback ───

  it("relayer A sees relayer B in peer list", async () => {
    const h = await sign(relayerA, "GET", "/api/peers");
    const { status, body } = await api("/api/peers", { headers: h });
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    const peers = body.peers as Array<Record<string, unknown>>;
    expect(peers[0].address).toBe(relayerB.address.toLowerCase());
    expect((peers[0].url as string).includes("relayer-")).toBe(true);
  });

  it("relayer B sees relayer A in peer list", async () => {
    const h = await sign(relayerB, "GET", "/api/peers");
    const { body } = await api("/api/peers", { headers: h });
    expect(body.count).toBe(1);
    const peers = body.peers as Array<Record<string, unknown>>;
    expect(peers[0].address).toBe(relayerA.address.toLowerCase());
  });

  // ─── Step 8: Duplicate order rejected ───

  it("duplicate order ID is rejected (409)", async () => {
    const h = await sign(relayerA, "POST", "/api/orders");
    const { status, body } = await api("/api/orders", {
      method: "POST", headers: h,
      body: JSON.stringify({
        sellToken: WETH, buyToken: USDC,
        sellAmount: "500000000000000000", buyAmount: "1000000000000",
        minFillAmount: "0", maxFee: 30,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        nonce: "100",
        pubKeyAx: "10001",
      }),
    });
    expect(status).toBe(409);
    expect(body.error).toBe("order already exists");
  });

  // ─── Step 9: Cancel flow ───

  it("relayer A cannot cancel relayer B's order (403)", async () => {
    const orderId = `${relayerB.address.toLowerCase()}-200`;
    const h = await sign(relayerA, "DELETE", `/api/orders/${orderId}`);
    const { status } = await api(`/api/orders/${orderId}`, {
      method: "DELETE", headers: h,
    });
    expect(status).toBe(403);
  });

  it("relayer B cancels own order via WebSocket broadcast", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/orders`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const msgPromise = waitForWsMessage(ws);
    const orderId = `${relayerB.address.toLowerCase()}-200`;
    const h = await sign(relayerB, "DELETE", `/api/orders/${orderId}`);
    const { status, body } = await api(`/api/orders/${orderId}`, {
      method: "DELETE", headers: h,
    });
    expect(status).toBe(200);
    expect(body.status).toBe("cancelled");

    // WebSocket should broadcast cancellation
    const msg = await msgPromise;
    expect(msg.type).toBe("order:cancelled");
    expect(msg.orderId).toBe(orderId);

    ws.close();
  });

  it("after cancel, only 1 open order remains", async () => {
    const { body } = await api("/api/orders");
    expect(body.count).toBe(1);
  });

  it("cannot cancel already-cancelled order (409)", async () => {
    const orderId = `${relayerB.address.toLowerCase()}-200`;
    const h = await sign(relayerB, "DELETE", `/api/orders/${orderId}`);
    const { status } = await api(`/api/orders/${orderId}`, {
      method: "DELETE", headers: h,
    });
    expect(status).toBe(409);
  });

  // ─── Step 10: Expired order handling ───

  it("posting an already-expired order is rejected", async () => {
    const h = await sign(relayerB, "POST", "/api/orders");
    const { status, body } = await api("/api/orders", {
      method: "POST", headers: h,
      body: JSON.stringify({
        sellToken: USDC, buyToken: WETH,
        sellAmount: "1000000000000", buyAmount: "500000000000000000",
        minFillAmount: "0", maxFee: 30,
        expiry: Math.floor(Date.now() / 1000) - 100,  // already expired
        nonce: "201",
        pubKeyAx: "20002",
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe("order already expired");
  });

  // ─── Step 11: Heartbeat ───

  it("relayer A heartbeat succeeds", async () => {
    const h = await sign(relayerA, "POST", "/api/relayers/heartbeat");
    const { status, body } = await api("/api/relayers/heartbeat", {
      method: "POST", headers: h, body: "{}",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  // ─── Step 12: Auth validation ───

  it("request without auth headers is rejected (401)", async () => {
    const { status } = await api("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellToken: WETH }),
    });
    expect(status).toBe(401);
  });

  it("request with wrong signature is rejected (401)", async () => {
    // Sign for a different path to test replay protection
    const h = await sign(relayerA, "POST", "/api/relayers/register");
    const { status } = await api("/api/orders", {
      method: "POST", headers: h,
      body: JSON.stringify({
        sellToken: WETH, buyToken: USDC,
        sellAmount: "1", buyAmount: "1",
        maxFee: 0, expiry: Math.floor(Date.now() / 1000) + 3600,
        nonce: "999",
        pubKeyAx: "99999",
      }),
    });
    // Should fail because signature was for /api/relayers/register, not /api/orders
    expect(status).toBe(401);
  });

  it("expired timestamp is rejected (401)", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 600).toString(); // 10 min ago
    const msg = `zkScatter-relay:${relayerA.address.toLowerCase()}:${ts}:POST:/api/orders:`;
    const sig = await relayerA.signMessage(msg);
    const { status } = await api("/api/orders", {
      method: "POST",
      headers: {
        "x-relayer-address": relayerA.address,
        "x-relayer-signature": sig,
        "x-relayer-timestamp": ts,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sellToken: WETH }),
    });
    expect(status).toBe(401);
  });

  // ─── Step 13: Relayer-specific order listing ───

  it("relayer A's orders retrievable from DB", async () => {
    const orders = db.listByRelayer(relayerA.address.toLowerCase());
    expect(orders.length).toBeGreaterThanOrEqual(1);
    expect(orders[0].order.relayer).toBe(relayerA.address.toLowerCase());
  });

  // ─── Step 14: Multiple orders + ordering ───

  it("relayer A posts a second order", async () => {
    const h = await sign(relayerA, "POST", "/api/orders");
    const { status } = await api("/api/orders", {
      method: "POST", headers: h,
      body: JSON.stringify({
        sellToken: WETH, buyToken: USDC,
        sellAmount: "500000000000000000", buyAmount: "1000000000000",
        minFillAmount: "0", maxFee: 20,
        expiry: Math.floor(Date.now() / 1000) + 7200,
        nonce: "101",
        pubKeyAx: "10002",
      }),
    });
    expect(status).toBe(201);
  });

  it("orders are sorted by createdAt ascending", async () => {
    const { body } = await api("/api/orders");
    expect(body.count).toBe(2);
    const orders = body.orders as Array<Record<string, unknown>>;
    expect((orders[0].createdAt as number) <= (orders[1].createdAt as number)).toBe(true);
  });

  // ─── Step 15: DB persistence (restore from DB) ───

  it("DB loadAllOpen returns correct count", () => {
    const open = db.loadAllOpen();
    expect(open.length).toBe(2);
    expect(open.every(o => o.status === "open")).toBe(true);
  });

  it("in-memory orderbook can be rebuilt from DB", () => {
    const fresh = new SharedOrderbook();
    const restored = fresh.loadFromStored(db.loadAllOpen());
    expect(restored).toBe(2);
    expect(fresh.getStats().totalOrders).toBe(2);
  });

  // ─── Step 16: Final stats ───

  it("final stats are correct", async () => {
    const { body } = await api("/api/stats");
    expect(body.totalOrders).toBe(2);
    expect(body.pairs).toBe(1);
    expect(body.relayers).toBe(2);
  });
});
