import { describe, it, expect } from "vitest";
import request from "supertest";
import { createRelayerStatsRoutes } from "../../src/routes/relayer-stats.js";
import { mountRouter, makeSubmitterStub, makeDbStub } from "./helpers.js";

describe("/api/relayer", () => {
  it("GET /stats returns aggregated stats + metrics", async () => {
    const db = makeDbStub({
      getRelayerStats: () => ({
        totalOrders: 12, settledOrders: 10, successRate: 0.83,
        crossRelayerSettled: 2, avgSettleTimeMs: 1500, uptimeSince: 123,
      }),
      getSettledVolume: () => [{ sellToken: "0xA", count: 3, totalVolume: "1000" }],
      getFeeTotals: () => [{ token: "0xb", count: 5, totalWei: "33750000" }],
    });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeSubmitterStub()));
    const res = await request(app).get("/api/relayer/stats");
    expect(res.status).toBe(200);
    expect(res.body.totalOrders).toBe(12);
    expect(res.body.pendingOrders).toBe(0); // no authorize orders in this test env
    expect(res.body.settledVolume).toEqual([{ sellToken: "0xA", count: 3, totalVolume: "1000" }]);
    expect(res.body.feeTotals).toEqual([{ token: "0xb", count: 5, totalWei: "33750000" }]);
    expect(res.body.metrics).toBeDefined();
  });

  it("GET /stats returns 500 when DB throws", async () => {
    const db = makeDbStub({ getRelayerStats: () => { throw new Error("db error"); } });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeSubmitterStub()));
    const res = await request(app).get("/api/relayer/stats");
    expect(res.status).toBe(500);
  });

  it("GET /trade-offers clamps limit to [1, 200] and offset to ≥0", async () => {
    const calls: Array<[number, number]> = [];
    const db = makeDbStub({
      getTradeOffers: (limit: number, offset: number) => { calls.push([limit, offset]); return []; },
    });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeSubmitterStub()));
    await request(app).get("/api/relayer/trade-offers?limit=9999&offset=-5");
    expect(calls[0]).toEqual([200, 0]);
    // limit=0 clamps up to 1 (smallest valid page) — aligns with
    // shared-orderbook clampLimit policy locked in PR #493.
    await request(app).get("/api/relayer/trade-offers?limit=0");
    expect(calls[1][0]).toBe(1);
    await request(app).get("/api/relayer/trade-offers");
    expect(calls[2]).toEqual([50, 0]);
    // Explicit out-of-range low value gets clamped to min 1
    await request(app).get("/api/relayer/trade-offers?limit=-5");
    expect(calls[3][0]).toBe(1);
  });

  it("GET /trade-offers projects out trader identifiers (no pubkeys/nonces/peer/reason)", async () => {
    // The full row carries operator-private identifiers; the UNAUTHENTICATED
    // public endpoint must expose only non-identifying fields (admin route
    // is SIWE-gated for the full row). Regression for the A-1 PII leak.
    const fullRow = {
      id: 7,
      direction: "sent" as const,
      peer_relayer: "0x" + "pe".repeat(20),
      maker_pub_key: "0x" + "11".repeat(32),
      maker_nonce: "42",
      taker_pub_key: "0x" + "22".repeat(32),
      taker_nonce: "43",
      status: "settled",
      tx_hash: "0x" + "ab".repeat(32),
      reason: "internal-failure-detail",
      created_at: 1234,
    };
    const db = makeDbStub({ getTradeOffers: () => [fullRow] });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeSubmitterStub()));
    const res = await request(app).get("/api/relayer/trade-offers");
    expect(res.status).toBe(200);
    expect(res.body.offers).toHaveLength(1);
    const offer = res.body.offers[0];
    // Safe fields present…
    expect(offer).toEqual({
      direction: "sent",
      status: "settled",
      txHash: "0x" + "ab".repeat(32),
      createdAt: 1234,
    });
    // …and no identifying field leaks (allowlist projection).
    const leaked = JSON.stringify(res.body);
    expect(leaked).not.toContain("maker_pub_key");
    expect(leaked).not.toContain("11".repeat(32)); // maker pubkey value
    expect(leaked).not.toContain("22".repeat(32)); // taker pubkey value
    expect(leaked).not.toContain("peer_relayer");
    expect(leaked).not.toContain("internal-failure-detail"); // reason
  });

  it("GET /trade-offers returns 500 when DB throws", async () => {
    const db = makeDbStub({ getTradeOffers: () => { throw new Error("db error"); } });
    const app = mountRouter("/api/relayer",
      createRelayerStatsRoutes(db, makeSubmitterStub()));
    const res = await request(app).get("/api/relayer/trade-offers");
    expect(res.status).toBe(500);
  });
});
