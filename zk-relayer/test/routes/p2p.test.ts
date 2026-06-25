import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import request from "supertest";
import { Wallet } from "ethers";
import { createP2PRoutes } from "../../src/routes/p2p.js";
import { mountRouter } from "./helpers.js";

// Dedicated peer wallet so we can produce valid x-relayer-signature values.
const peerWallet = new Wallet("0x" + "1".repeat(64));

const EMPTY_BODY_SHA256 =
  "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Body-bound auth — must hash the exact bytes supertest serializes
// (`JSON.stringify(body)`) so the server's rawBody hash matches. The
// legacy non-body-bound shape is fail-closed by default now.
async function authHeaders(method: string, path: string, relayerUrl = "", body?: unknown) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const address = peerWallet.address;
  const bodyHash = body === undefined
    ? EMPTY_BODY_SHA256
    : "0x" + createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const message = `zkScatter-relay:${address.toLowerCase()}:${timestamp}:${method.toUpperCase()}:${path}:${relayerUrl}:${bodyHash}`;
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
    const { sellToken: _s, ...missingSellToken } = VALID_ORDER;
    const headers = await authHeaders("POST", "/api/p2p/orders", "", missingSellToken);
    const res = await request(app).post("/api/p2p/orders").set(headers).send(missingSellToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sellToken/);
  });

  it("rejects order whose relayer does not match peer identity with 403", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn()));
    const impostor = { ...VALID_ORDER, relayer: "0x" + "f".repeat(40) };
    const headers = await authHeaders("POST", "/api/p2p/orders", "", impostor);
    const res = await request(app).post("/api/p2p/orders").set(headers).send(impostor);
    expect(res.status).toBe(403);
  });

  it("accepts a valid order and calls onRemoteOrder", async () => {
    const onRemote = vi.fn();
    const app = mountRouter("/api/p2p", createP2PRoutes(onRemote, vi.fn()));
    const headers = await authHeaders("POST", "/api/p2p/orders", "", VALID_ORDER);
    const res = await request(app).post("/api/p2p/orders").set(headers).send(VALID_ORDER);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("received");
    expect(onRemote).toHaveBeenCalledOnce();
  });
});

describe("DELETE /api/p2p/orders/:id", () => {
  // Ownership check now goes through `lookupOrderRelayer` (last arg of
  // createP2PRoutes) instead of parsing `{relayer}-{nonce}` out of the
  // id, since authorize-flow ids are bytes32(nullifier) with no
  // embedded relayer.
  const otherRelayer = "0x" + "c".repeat(40);
  const otherId = "0xfeedface".padEnd(66, "0");

  it("rejects cancel of another relayer's order with 403", async () => {
    const lookup = vi.fn(() => otherRelayer); // order owned by someone else
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn(), undefined, undefined, lookup));
    const headers = await authHeaders("DELETE", `/api/p2p/orders/${otherId}`);
    const res = await request(app).delete(`/api/p2p/orders/${otherId}`).set(headers);
    expect(res.status).toBe(403);
  });

  it("accepts cancel when peer owns the order", async () => {
    const onCancel = vi.fn();
    const lookup = vi.fn(() => peerWallet.address.toLowerCase());
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), onCancel, undefined, undefined, lookup));
    const headers = await authHeaders("DELETE", `/api/p2p/orders/${otherId}`);
    const res = await request(app).delete(`/api/p2p/orders/${otherId}`).set(headers);
    expect(res.status).toBe(200);
    expect(onCancel).toHaveBeenCalledWith(otherId);
  });

  it("accepts cancel when order is unknown to our cache (idempotent)", async () => {
    // Lookup wired but returns null — order isn't in our cache, treat
    // as already-cancelled / never-seen and accept. Still forwards to
    // `onCancel` so downstream stores (e.g. `RemoteOrderStore.remove`)
    // can run their own no-op deletion paths idempotently.
    const onCancel = vi.fn();
    const lookup = vi.fn(() => null);
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), onCancel, undefined, undefined, lookup));
    const headers = await authHeaders("DELETE", `/api/p2p/orders/${otherId}`);
    const res = await request(app).delete(`/api/p2p/orders/${otherId}`).set(headers);
    expect(res.status).toBe(200);
    expect(onCancel).toHaveBeenCalledWith(otherId);
  });

  it("rejects with 403 when no lookup callback is configured (fail-closed)", async () => {
    // Without `lookupOrderRelayer` we can't enforce ownership. Old
    // behaviour silently accepted, which would let any authenticated
    // peer cancel any order. Fail closed instead.
    const onCancel = vi.fn();
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), onCancel));
    const headers = await authHeaders("DELETE", `/api/p2p/orders/${otherId}`);
    const res = await request(app).delete(`/api/p2p/orders/${otherId}`).set(headers);
    expect(res.status).toBe(403);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("POST /api/p2p/trade-offer (retired Private flow)", () => {
  it("returns 404 — route deleted with tracker #29 cleanup", async () => {
    const app = mountRouter("/api/p2p", createP2PRoutes(vi.fn(), vi.fn(), undefined));
    const res = await request(app).post("/api/p2p/trade-offer").send({});
    expect(res.status).toBe(404);
  });
});
