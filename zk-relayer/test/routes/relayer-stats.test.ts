import { describe, it, expect } from "vitest";
import request from "supertest";
import { createRelayerStatsRoutes } from "../../src/routes/relayer-stats.js";
import { mountRouter, makeSubmitterStub, makeDbStub, makeOrderbookStub } from "./helpers.js";

describe("/api/relayer", () => {
  it("GET /stats returns aggregated stats + metrics", async () => {
    const db = makeDbStub({
      getRelayerStats: () => ({
        totalOrders: 12, settledOrders: 10, successRate: 0.83,
        crossRelayerSettled: 2, avgSettleTimeMs: 1500, uptimeSince: 123,
      }),
      getSettledVolume: () => [{ sellToken: "0xA", count: 3, totalVolume: "1000" }],
    });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeOrderbookStub({ pendingOrderCount: 4 }), makeSubmitterStub()));
    const res = await request(app).get("/api/relayer/stats");
    expect(res.status).toBe(200);
    expect(res.body.totalOrders).toBe(12);
    expect(res.body.pendingOrders).toBe(4);
    expect(res.body.settledVolume).toEqual([{ sellToken: "0xA", count: 3, totalVolume: "1000" }]);
    expect(res.body.metrics).toBeDefined();
  });

  it("GET /stats returns 500 when DB throws", async () => {
    const db = makeDbStub({ getRelayerStats: () => { throw new Error("db error"); } });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeOrderbookStub(), makeSubmitterStub()));
    const res = await request(app).get("/api/relayer/stats");
    expect(res.status).toBe(500);
  });

  it("GET /trade-offers clamps limit to [1, 200] and offset to ≥0", async () => {
    const calls: Array<[number, number]> = [];
    const db = makeDbStub({
      getTradeOffers: (limit: number, offset: number) => { calls.push([limit, offset]); return []; },
    });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeOrderbookStub(), makeSubmitterStub()));
    await request(app).get("/api/relayer/trade-offers?limit=9999&offset=-5");
    expect(calls[0]).toEqual([200, 0]);
    // limit=0 is falsy → falls back to default 50 (documented quirk of `|| 50`)
    await request(app).get("/api/relayer/trade-offers?limit=0");
    expect(calls[1][0]).toBe(50);
    await request(app).get("/api/relayer/trade-offers");
    expect(calls[2]).toEqual([50, 0]);
    // Explicit out-of-range low value gets clamped to min 1
    await request(app).get("/api/relayer/trade-offers?limit=-5");
    expect(calls[3][0]).toBe(1);
  });

  it("GET /trade-offers returns 500 when DB throws", async () => {
    const db = makeDbStub({ getTradeOffers: () => { throw new Error("db error"); } });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeOrderbookStub(), makeSubmitterStub()));
    const res = await request(app).get("/api/relayer/trade-offers");
    expect(res.status).toBe(500);
  });
});
