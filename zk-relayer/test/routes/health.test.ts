import { describe, it, expect } from "vitest";
import request from "supertest";
import { createHealthRoutes } from "../../src/routes/health.js";
import { mountRouter, makeSubmitterStub, makeDbStub } from "./helpers.js";

describe("[R-13] GET /health", () => {
  it("returns 200 healthy when RPC + DB both succeed", async () => {
    const app = mountRouter("/health", createHealthRoutes(makeSubmitterStub(), makeDbStub()));
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.checks).toEqual({ rpc: "ok", db: "ok" });
    expect(typeof res.body.uptime).toBe("number");
  });

  it("returns 503 degraded when RPC fails", async () => {
    const submitter = makeSubmitterStub({
      getProvider: () => ({ getBlockNumber: async () => { throw new Error("rpc down"); } }),
    });
    const app = mountRouter("/health", createHealthRoutes(submitter, makeDbStub()));
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.rpc).toBe("error");
    expect(res.body.checks.db).toBe("ok");
  });

  it("returns 503 degraded when DB write fails", async () => {
    const db = makeDbStub({ setMeta: () => { throw new Error("db closed"); } });
    const app = mountRouter("/health", createHealthRoutes(makeSubmitterStub(), db));
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.checks.db).toBe("error");
  });
});
