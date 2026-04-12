import { describe, it, expect } from "vitest";
import request from "supertest";
import { createOrderbookRoutes } from "../../src/routes/orderbook.js";
import { mountRouter, makeOrderbookStub } from "./helpers.js";

describe("GET /api/private-orderbook", () => {
  it("returns only the pending count — never exposes individual orders", async () => {
    const app = mountRouter("/api/private-orderbook",
      createOrderbookRoutes(makeOrderbookStub({ getOrderCount: () => 42 })));
    const res = await request(app).get("/api/private-orderbook");
    expect(res.status).toBe(200);
    // Privacy invariant: only `totalOrders` is ever returned. If a regression
    // adds any other key the strict toEqual fails — no per-order data leaks.
    expect(res.body).toEqual({ totalOrders: 42 });
  });

  it("returns 0 when orderbook is empty", async () => {
    const app = mountRouter("/api/private-orderbook",
      createOrderbookRoutes(makeOrderbookStub({ getOrderCount: () => 0 })));
    const res = await request(app).get("/api/private-orderbook");
    expect(res.status).toBe(200);
    expect(res.body.totalOrders).toBe(0);
  });
});
