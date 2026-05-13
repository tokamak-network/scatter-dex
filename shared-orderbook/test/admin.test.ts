/**
 * Coverage for /api/admin/verify-stats: disabled-without-token,
 * missing / wrong / right bearer, and the report shape (lastPass +
 * hasUnverifiedRows).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import express from "express";
import { OrderbookDB } from "../src/core/db.js";
import { createAdminRoutes } from "../src/routes/admin.js";
import { VerifyMonitor } from "../src/core/verify-runtime.js";

const TEST_DB = "/tmp/shared-ob-admin.db";
const PORT = 14630;

function startApp(token: string | undefined, monitor: VerifyMonitor, db: OrderbookDB): http.Server {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRoutes({ db, monitor, adminToken: token }));
  return app.listen(PORT);
}

async function getStats(headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${PORT}/api/admin/verify-stats`, { headers });
  return { status: res.status, json: await res.json() };
}

describe("/api/admin/verify-stats", () => {
  let db: OrderbookDB;
  let monitor: VerifyMonitor;
  let server: http.Server | undefined;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = new OrderbookDB(TEST_DB);
    monitor = new VerifyMonitor();
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("returns 503 when ADMIN_TOKEN is unset (endpoint disabled)", async () => {
    server = startApp(undefined, monitor, db);
    const r = await getStats({ Authorization: "Bearer anything" });
    expect(r.status).toBe(503);
  });

  it("returns 401 when the bearer header is missing", async () => {
    server = startApp("secret-token", monitor, db);
    const r = await getStats({});
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("missing bearer token");
  });

  it("returns 401 on a wrong token", async () => {
    server = startApp("secret-token", monitor, db);
    const r = await getStats({ Authorization: "Bearer wrong" });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("invalid bearer token");
  });

  it("returns 401 when the supplied token is a prefix of the real one (constant-time)", async () => {
    server = startApp("secret-token", monitor, db);
    const r = await getStats({ Authorization: "Bearer secret" });
    expect(r.status).toBe(401);
  });

  it("returns 200 with the empty-state shape on a fresh DB + monitor", async () => {
    server = startApp("secret-token", monitor, db);
    const r = await getStats({ Authorization: "Bearer secret-token" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      lastPass: null,
      totalPasses: 0,
      hasUnverifiedRows: false,
      oldestUnverifiedBlock: null,
    });
  });

  it("reports lastPass + oldestUnverifiedBlock when rows exist", async () => {
    db.insertSettlement(
      "0x" + "11".repeat(20),
      {
        txHash: "0x" + "a1".repeat(32),
        blockNumber: 42,
        makerRelayer: "0x" + "11".repeat(20),
        takerRelayer: "0x" + "22".repeat(20),
        makerNullifier: "0x" + "01".repeat(32),
        takerNullifier: "0x" + "02".repeat(32),
        feeMaker: "0",
        feeTaker: "0",
        userMaxFeeMaker: 30,
        userMaxFeeTaker: 30,
      },
    );

    monitor.record({
      startedAt: 1,
      finishedAt: 2,
      scanned: 1,
      flipped: 0,
      unmatched: 1,
      unmatchedByReason: { "no-event": 1, "tx-mismatch": 0, "relayer-mismatch": 0 },
      maxBlock: 100,
      error: null,
    });

    server = startApp("secret-token", monitor, db);
    const r = await getStats({ Authorization: "Bearer secret-token" });
    expect(r.status).toBe(200);
    expect(r.json.hasUnverifiedRows).toBe(true);
    expect(r.json.oldestUnverifiedBlock).toBe(42);
    expect(r.json.totalPasses).toBe(1);
    expect((r.json.lastPass as { scanned: number }).scanned).toBe(1);
  });
});
