import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { Wallet } from "ethers";
import { createP2PRoutes } from "../../src/routes/p2p.js";
import { mountRouter } from "./helpers.js";

// Dedicated peer wallet so we can produce valid x-relayer-signature values.
const peerWallet = new Wallet("0x" + "1".repeat(64));

async function authHeaders(method: string, path: string, relayerUrl = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const address = peerWallet.address;
  const message = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method.toUpperCase()}:${path}:${relayerUrl}`;
  const signature = await peerWallet.signMessage(message);
  return {
    "x-relayer-address": address,
    "x-relayer-signature": signature,
    "x-relayer-timestamp": timestamp,
    "x-relayer-url": relayerUrl,
  };
}

const VALID_ORDER = {
  id: "0xaaa-1",
  relayer: peerWallet.address,
  relayerUrl: "http://peer:3002",
  nonce: "1",
  sellToken: "0x" + "a".repeat(40),
  buyToken: "0x" + "b".repeat(40),
  sellAmount: "100",
  buyAmount: "200",
  minFillAmount: "200",
  maxFee: 60,
  expiry: Math.floor(Date.now() / 1000) + 3600,
  createdAt: Math.floor(Date.now() / 1000),
};

describe("POST /api/p2p/orders", () => {
  it("rejects missing auth headers with 401", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn()));
    const res = await request(app).post("/api/p2p/orders").send(VALID_ORDER);
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamp with 401", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn()));
    const stale = (Math.floor(Date.now() / 1000) - 600).toString();
    const message = `zkScatter-relay:${peerWallet.address.toLowerCase()}:${stale}:POST:/api/p2p/orders:`;
    const signature = await peerWallet.signMessage(message);
    const res = await request(app)
      .post("/api/p2p/orders")
      .set("x-relayer-address", peerWallet.address)
      .set("x-relayer-signature", signature)
      .set("x-relayer-timestamp", stale)
      .send(VALID_ORDER);
    expect(res.status).toBe(401);
  });

  it("rejects missing required order fields with 400", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn()));
    const headers = await authHeaders("POST", "/api/p2p/orders");
    const { sellToken: _s, ...missingSellToken } = VALID_ORDER;
    const res = await request(app).post("/api/p2p/orders").set(headers).send(missingSellToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sellToken/);
  });

  it("rejects order whose relayer does not match peer identity with 403", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn()));
    const headers = await authHeaders("POST", "/api/p2p/orders");
    const impostor = { ...VALID_ORDER, relayer: "0x" + "f".repeat(40) };
    const res = await request(app).post("/api/p2p/orders").set(headers).send(impostor);
    expect(res.status).toBe(403);
  });

  it("accepts a valid order and calls onRemoteOrder", async () => {
    const onRemote = vi.fn();
    const app = mountRouter("/api/p2p", createP2PRoutes(onRemote, vi.fn()));
    const headers = await authHeaders("POST", "/api/p2p/orders");
    const res = await request(app).post("/api/p2p/orders").set(headers).send(VALID_ORDER);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("received");
    expect(onRemote).toHaveBeenCalledOnce();
  });
});

describe("DELETE /api/p2p/orders/:id", () => {
  it("rejects cancel of another relayer's order with 403", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn()));
    const otherId = "0x" + "c".repeat(40) + "-42";
    const headers = await authHeaders("DELETE", `/api/p2p/orders/${otherId}`);
    const res = await request(app).delete(`/api/p2p/orders/${otherId}`).set(headers);
    expect(res.status).toBe(403);
  });

  it("accepts cancel when id is prefixed with peer address", async () => {
    const onCancel = vi.fn();
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), onCancel));
    const ownId = `${peerWallet.address.toLowerCase()}-7`;
    const headers = await authHeaders("DELETE", `/api/p2p/orders/${ownId}`);
    const res = await request(app).delete(`/api/p2p/orders/${ownId}`).set(headers);
    expect(res.status).toBe(200);
    expect(onCancel).toHaveBeenCalledWith(ownId);
  });
});

describe("POST /api/p2p/trade-offer", () => {
  it("returns 404 when trade-offer handler is not registered", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn()));
    const headers = await authHeaders("POST", "/api/p2p/trade-offer");
    const res = await request(app).post("/api/p2p/trade-offer").set(headers).send({});
    expect(res.status).toBe(404);
  });

  it("rejects missing makerNonce with 400", async () => {
    const onOffer = vi.fn();
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn(), onOffer));
    const headers = await authHeaders("POST", "/api/p2p/trade-offer");
    const res = await request(app).post("/api/p2p/trade-offer").set(headers).send({ makerPubKeyAx: "1" });
    expect(res.status).toBe(400);
  });

  it("rejects non-decimal makerNonce with 400", async () => {
    const onOffer = vi.fn();
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn(), onOffer));
    const headers = await authHeaders("POST", "/api/p2p/trade-offer");
    const res = await request(app)
      .post("/api/p2p/trade-offer")
      .set(headers)
      .send({ makerNonce: "0xabc", makerPubKeyAx: "1", takerOrder: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/makerNonce/);
  });

  it("invokes handler and returns its response", async () => {
    const onOffer = vi.fn(async () => ({ status: "accepted" as const, txHash: "0xabc" }));
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn(), onOffer));
    const headers = await authHeaders("POST", "/api/p2p/trade-offer");
    const res = await request(app)
      .post("/api/p2p/trade-offer")
      .set(headers)
      .send({ makerNonce: "42", makerPubKeyAx: "1", takerOrder: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted", txHash: "0xabc" });
  });
});
