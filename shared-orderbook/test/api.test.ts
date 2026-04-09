import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import cors from "cors";
import { Wallet } from "ethers";
import { SharedOrderbook } from "../src/core/orderbook.js";
import { OrderbookDB } from "../src/core/db.js";
import { OrderBroadcaster } from "../src/core/broadcaster.js";
import { createOrderRoutes } from "../src/routes/orders.js";
import { createRelayerRoutes } from "../src/routes/relayers.js";
import { createStatsRoutes } from "../src/routes/stats.js";
import { createPeerRoutes } from "../src/routes/peer.js";
import fs from "fs";

const TEST_DB = "/tmp/shared-orderbook-api-test.db";
const PORT = 14567;

// Generate two deterministic relayer wallets
const relayerA = new Wallet("0x" + "a1".repeat(32));
const relayerB = new Wallet("0x" + "b2".repeat(32));

async function authHeaders(wallet: Wallet, method: string, path: string, url = "http://localhost:" + PORT) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:${method.toUpperCase()}:${path}`;
  const signature = await wallet.signMessage(message);
  return {
    "x-relayer-address": wallet.address,
    "x-relayer-signature": signature,
    "x-relayer-timestamp": ts,
    "x-relayer-url": url,
    "Content-Type": "application/json",
  };
}

async function fetchJSON(path: string, init?: RequestInit) {
  const res = await fetch(`http://localhost:${PORT}${path}`, init);
  const body = await res.json();
  return { status: res.status, body };
}

// No-op rate limiter for tests
const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

describe("API integration", () => {
  let server: http.Server;
  let db: OrderbookDB;
  let orderbook: SharedOrderbook;
  let broadcaster: OrderBroadcaster;

  beforeAll(async () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
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

    server = http.createServer(app);
    broadcaster.attach(server);

    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    broadcaster.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
    try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("POST /api/relayers/register — registers relayer A", async () => {
    const headers = await authHeaders(relayerA, "POST", "/api/relayers/register");
    const { status, body } = await fetchJSON("/api/relayers/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "relayer-a" }),
    });
    expect(status).toBe(200);
    expect(body.address).toBe(relayerA.address.toLowerCase());
    expect(body.name).toBe("relayer-a");
  });

  it("POST /api/relayers/register — registers relayer B", async () => {
    const headers = await authHeaders(relayerB, "POST", "/api/relayers/register");
    const { status, body } = await fetchJSON("/api/relayers/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "relayer-b" }),
    });
    expect(status).toBe(200);
    expect(body.address).toBe(relayerB.address.toLowerCase());
  });

  it("GET /api/relayers — lists active relayers", async () => {
    const { status, body } = await fetchJSON("/api/relayers");
    expect(status).toBe(200);
    expect(body.count).toBe(2);
  });

  it("POST /api/orders — relayer A posts an order", async () => {
    const headers = await authHeaders(relayerA, "POST", "/api/orders");
    const { status, body } = await fetchJSON("/api/orders", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sellToken: "0x" + "a".repeat(40),
        buyToken: "0x" + "b".repeat(40),
        sellAmount: "1000000000000000000",
        buyAmount: "2000000000000000000",
        minFillAmount: "0",
        maxFee: 30,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        nonce: "1",
      }),
    });
    expect(status).toBe(201);
    expect(body.status).toBe("open");
  });

  it("POST /api/orders — relayer B posts counterparty order", async () => {
    const headers = await authHeaders(relayerB, "POST", "/api/orders");
    const { status, body } = await fetchJSON("/api/orders", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sellToken: "0x" + "b".repeat(40),
        buyToken: "0x" + "a".repeat(40),
        sellAmount: "2000000000000000000",
        buyAmount: "1000000000000000000",
        minFillAmount: "0",
        maxFee: 30,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        nonce: "1",
      }),
    });
    expect(status).toBe(201);
  });

  it("GET /api/orders — lists all open orders", async () => {
    const { status, body } = await fetchJSON("/api/orders");
    expect(status).toBe(200);
    expect(body.count).toBe(2);
  });

  it("GET /api/orders/:pair — filters by pair", async () => {
    const tokenA = "0x" + "a".repeat(40);
    const tokenB = "0x" + "b".repeat(40);
    const pair = tokenA < tokenB ? `${tokenA}-${tokenB}` : `${tokenB}-${tokenA}`;
    const { status, body } = await fetchJSON(`/api/orders/${pair}`);
    expect(status).toBe(200);
    expect(body.count).toBe(2);
  });

  it("GET /api/stats — returns stats", async () => {
    const { status, body } = await fetchJSON("/api/stats");
    expect(status).toBe(200);
    expect(body.totalOrders).toBe(2);
    expect(body.relayers).toBe(2);
  });

  it("GET /api/peers — relayer A sees relayer B as peer", async () => {
    const headers = await authHeaders(relayerA, "GET", "/api/peers");
    const { status, body } = await fetchJSON("/api/peers", { headers });
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.peers[0].address).toBe(relayerB.address.toLowerCase());
  });

  it("DELETE /api/orders/:id — relayer A cancels own order", async () => {
    const orderId = `${relayerA.address.toLowerCase()}-1`;
    const headers = await authHeaders(relayerA, "DELETE", `/api/orders/${orderId}`);
    const { status, body } = await fetchJSON(`/api/orders/${orderId}`, {
      method: "DELETE",
      headers,
    });
    expect(status).toBe(200);
    expect(body.status).toBe("cancelled");
  });

  it("DELETE /api/orders/:id — relayer B cannot cancel relayer A's order", async () => {
    // Order already cancelled, but test the 403 path with relayer B's order
    const orderId = `${relayerB.address.toLowerCase()}-1`;
    const headers = await authHeaders(relayerA, "DELETE", `/api/orders/${orderId}`); // relayer A trying to cancel B's
    const { status, body } = await fetchJSON(`/api/orders/${orderId}`, {
      method: "DELETE",
      headers,
    });
    expect(status).toBe(403);
    expect(body.error).toBe("not your order");
  });

  it("POST /api/orders — rejects unauthenticated request", async () => {
    const { status } = await fetchJSON("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellToken: "0x" + "a".repeat(40) }),
    });
    expect(status).toBe(401);
  });

  it("POST /api/relayers/heartbeat — keeps relayer alive", async () => {
    const headers = await authHeaders(relayerA, "POST", "/api/relayers/heartbeat");
    const { status, body } = await fetchJSON("/api/relayers/heartbeat", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });
});
