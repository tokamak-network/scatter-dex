import { describe, it, expect } from "vitest";
import request from "supertest";
import { createPrivateOrderRoutes } from "../../src/routes/orders.js";
import { mountRouter, makeSubmitterStub, makeOrderbookStub } from "./helpers.js";

function buildApp(orderbook = makeOrderbookStub()) {
  return mountRouter("/api/private-orders", createPrivateOrderRoutes(orderbook, makeSubmitterStub()));
}

describe("POST /api/private-orders (legacy)", () => {
  it("returns 410 with migration hint", async () => {
    const res = await request(buildApp()).post("/api/private-orders").send({});
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/deprecated/i);
    expect(res.body.migration).toMatch(/authorize-orders/i);
  });
});

describe("GET /api/private-orders/:pubKeyAx", () => {
  it("returns empty array when orderbook has no orders", async () => {
    const res = await request(buildApp()).get("/api/private-orders/123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects invalid pubKeyAx with 400", async () => {
    const res = await request(buildApp()).get("/api/private-orders/not-a-bigint");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pubKeyAx/i);
  });

  it("rejects invalid status filter with 400", async () => {
    const res = await request(buildApp()).get("/api/private-orders/123?status=nonsense");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  it("returns paginated response when any query param is present", async () => {
    const orderbook = makeOrderbookStub({
      getOrderHistory: () => [],
      countOrders: () => 0,
    });
    const res = await request(buildApp(orderbook)).get("/api/private-orders/123?limit=10&offset=0");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orders: [], total: 0, limit: 10, offset: 0 });
  });

  it("clamps limit to [1, 200] and offset to ≥0", async () => {
    const calls: Array<{ limit: number; offset: number }> = [];
    const orderbook = makeOrderbookStub({
      getOrderHistory: (_pk: bigint, opts: { limit: number; offset: number }) => {
        calls.push({ limit: opts.limit, offset: opts.offset });
        return [];
      },
    });
    const app = buildApp(orderbook);
    await request(app).get("/api/private-orders/1?limit=9999&offset=-5");
    expect(calls[0]).toEqual({ limit: 200, offset: 0 });
    // `|| 50` zero-falsy quirk (same as relayer-stats): limit=0 → 50
    await request(app).get("/api/private-orders/1?limit=0");
    expect(calls[1].limit).toBe(50);
    await request(app).get("/api/private-orders/1?limit=-1");
    expect(calls[2].limit).toBe(1);
  });
});

describe("GET /api/private-orders/:pubKeyAx/:nonce", () => {
  it("returns 404 when order not found", async () => {
    const res = await request(buildApp()).get("/api/private-orders/1/999");
    expect(res.status).toBe(404);
  });

  it("rejects invalid nonce with 400", async () => {
    const res = await request(buildApp()).get("/api/private-orders/1/nope");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/private-orders/:pubKeyAx/:nonce", () => {
  it("rejects request without x-cancel-signature with 401", async () => {
    const res = await request(buildApp()).delete("/api/private-orders/1/1");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("rejects invalid pubKeyAx/nonce with 400", async () => {
    const res = await request(buildApp())
      .delete("/api/private-orders/bad/1")
      .set("x-cancel-signature", "{}");
    expect(res.status).toBe(400);
  });

  it("rejects malformed signature JSON with 400", async () => {
    const orderbook = makeOrderbookStub({
      getOrderByNonce: () => ({ order: { pubKeyAy: 999n } }),
    });
    const res = await request(buildApp(orderbook))
      .delete("/api/private-orders/1/1")
      .set("x-cancel-signature", "{not-json");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });
});
