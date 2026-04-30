import { describe, it, expect } from "vitest";
import request from "supertest";
import { createMetricsRoutes } from "../../src/routes/metrics.js";
import { mountRouter, makeDbStub } from "./helpers.js";

function parseMetrics(body: string): Record<string, Array<{ labels: Record<string, string>; value: number }>> {
  const out: Record<string, Array<{ labels: Record<string, string>; value: number }>> = {};
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)$/);
    if (!match) continue;
    const [, name, labelStr, valueStr] = match;
    const labels: Record<string, string> = {};
    if (labelStr) {
      for (const pair of labelStr.slice(1, -1).split(",")) {
        const m = pair.match(/^([^=]+)="(.*)"$/);
        if (m) labels[m[1]] = m[2];
      }
    }
    (out[name] ??= []).push({ labels, value: Number(valueStr) });
  }
  return out;
}

describe("GET /metrics", () => {
  it("emits Prometheus exposition format with content-type text/plain", async () => {
    const db = makeDbStub({
      getRelayerStats: () => ({
        totalOrders: 12,
        settledOrders: 10,
        successRate: 83,
        crossRelayerSettled: 2,
        totalTradeOffers: 5,
        settledTradeOffers: 3,
        avgSettleTimeMs: 1500,
        uptimeSince: Date.now() - 60_000,
      }),
      getSettledVolume: () => [
        { sellToken: "0xAaaa", count: 3, totalVolume: "1000000000" },
      ],
    });
    const app = mountRouter("/metrics", createMetricsRoutes(db));
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("# HELP relayer_up");
    expect(res.text).toContain("# TYPE relayer_up gauge");

    const m = parseMetrics(res.text);
    expect(m.relayer_up?.[0].value).toBe(1);
    expect(m.relayer_orders_total?.[0].value).toBe(12);
    expect(m.relayer_orders_settled_total?.[0].value).toBe(10);
    expect(m.relayer_success_rate_percent?.[0].value).toBe(83);
    expect(m.relayer_cross_relayer_settled_total?.[0].value).toBe(2);
    expect(m.relayer_trade_offers_total?.[0].value).toBe(5);
    expect(m.relayer_uptime_seconds?.[0].value).toBeGreaterThanOrEqual(60);

    const volume = m.relayer_settled_volume_wei?.[0];
    expect(volume?.labels.token).toBe("0xaaaa");
    expect(volume?.value).toBe(1_000_000_000);
  });

  it("omits gas/duration samples when no settlements have been recorded", async () => {
    const app = mountRouter("/metrics", createMetricsRoutes(makeDbStub()));
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("relayer_settlement_duration_avg_ms");
    expect(res.text).not.toContain("relayer_settlement_gas_avg_eth");
    // Always-present gauges remain.
    expect(res.text).toContain("relayer_up 1");
    expect(res.text).toContain("relayer_paused");
  });

  it("returns 500 with a parseable error marker when the DB throws", async () => {
    const db = makeDbStub({ getRelayerStats: () => { throw new Error("db error"); } });
    const app = mountRouter("/metrics", createMetricsRoutes(db));
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(500);
    expect(res.text).toContain("metrics_render_error");
  });

  it("escapes double quotes and backslashes in token-label values", async () => {
    const db = makeDbStub({
      getSettledVolume: () => [
        { sellToken: '0xWith"Quote\\Slash', count: 1, totalVolume: "1" },
      ],
    });
    const app = mountRouter("/metrics", createMetricsRoutes(db));
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain('token="0xwith\\"quote\\\\slash"');
  });
});
