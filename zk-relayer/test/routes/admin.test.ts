import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createAdminRoutes } from "../../src/routes/admin.js";
import { clearSanctionedPubKeys } from "../../src/core/sanctions-list.js";
import { config, updateRelayerFee } from "../../src/config.js";
import { mountRouter, makeSubmitterStub, makeDbStub } from "./helpers.js";

const ADMIN_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_KEY) throw new Error("ADMIN_API_KEY must be set (see test/setup-env.ts)");

function buildApp(opts: {
  db?: ReturnType<typeof makeDbStub>;
  drainAuthorizeOrders?: () => number;
  getAuthorizeOrderStats?: () => { pending: number; matched: number; total: number };
} = {}) {
  const router = createAdminRoutes({
    submitter: makeSubmitterStub(),
    db: opts.db ?? makeDbStub(),
    drainAuthorizeOrders: opts.drainAuthorizeOrders ?? (() => 0),
    getAuthorizeOrderStats: opts.getAuthorizeOrderStats ?? (() => ({ pending: 0, matched: 0, total: 0 })),
  });
  return mountRouter("/api/admin", router);
}

describe("/api/admin — auth", () => {
  it("rejects request without x-admin-key with 401", async () => {
    const res = await request(buildApp()).get("/api/admin/status");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/admin/i);
  });

  it("rejects wrong key length with 401 (timing-safe guard)", async () => {
    const res = await request(buildApp())
      .get("/api/admin/status")
      .set("x-admin-key", "short");
    expect(res.status).toBe(401);
  });

  it("rejects matching length but wrong value with 401", async () => {
    const wrong = "x".repeat(ADMIN_KEY.length);
    const res = await request(buildApp())
      .get("/api/admin/status")
      .set("x-admin-key", wrong);
    expect(res.status).toBe(401);
  });

  it("accepts correct key and returns 200", async () => {
    const res = await request(buildApp())
      .get("/api/admin/status")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
  });
});

describe("/api/admin/status + /balance", () => {
  it("GET /status includes relayer config + paused state + authorizeOrders", async () => {
    const res = await request(buildApp({
      getAuthorizeOrderStats: () => ({ pending: 5, matched: 2, total: 7 }),
    }))
      .get("/api/admin/status")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.authorizeOrders).toEqual({ pending: 5, matched: 2, total: 7 });
    expect(res.body.privateOrders).toBeUndefined();
    expect(res.body.feeBps).toBeTypeOf("number");
  });

  it("GET /balance returns wallet + chainId", async () => {
    const res = await request(buildApp())
      .get("/api/admin/balance")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.address).toMatch(/^0x/);
    expect(res.body.chainId).toBe(31337);
  });
});

describe("/api/admin/fee", () => {
  // PUT /fee mutates the module-level `config.relayerFee`. Snapshot it so
  // a failure doesn't bleed into other tests sharing the same vitest worker.
  const originalFee = config.relayerFee;
  afterEach(() => { updateRelayerFee(originalFee); });

  it("rejects non-integer with 400", async () => {
    const res = await request(buildApp())
      .put("/api/admin/fee")
      .set("x-admin-key", ADMIN_KEY)
      .send({ feeBps: 12.5 });
    expect(res.status).toBe(400);
  });

  it("rejects out-of-range (>10000) with 400", async () => {
    const res = await request(buildApp())
      .put("/api/admin/fee")
      .set("x-admin-key", ADMIN_KEY)
      .send({ feeBps: 10001 });
    expect(res.status).toBe(400);
  });

  it("rejects negative with 400", async () => {
    const res = await request(buildApp())
      .put("/api/admin/fee")
      .set("x-admin-key", ADMIN_KEY)
      .send({ feeBps: -1 });
    expect(res.status).toBe(400);
  });

  it("accepts valid feeBps and persists via db.setMeta", async () => {
    const setMetaCalls: Array<[string, string]> = [];
    const db = makeDbStub({ setMeta: (k: string, v: string) => { setMetaCalls.push([k, v]); } });
    const res = await request(buildApp({ db }))
      .put("/api/admin/fee")
      .set("x-admin-key", ADMIN_KEY)
      .send({ feeBps: 55 });
    expect(res.status).toBe(200);
    expect(res.body.newFeeBps).toBe(55);
    expect(setMetaCalls).toContainEqual(["relayerFee", "55"]);
  });
});

describe("/api/admin/pause + /resume", () => {
  it("pause → resume is a valid cycle; double-pause / double-resume return 409", async () => {
    const app = buildApp();
    let res = await request(app).post("/api/admin/pause").set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");

    res = await request(app).post("/api/admin/pause").set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(409);

    res = await request(app).post("/api/admin/resume").set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);

    res = await request(app).post("/api/admin/resume").set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(409);
  });
});

describe("/api/admin/drain", () => {
  it("returns count from authorize drain", async () => {
    const res = await request(buildApp({
      drainAuthorizeOrders: () => 7,
    }))
      .post("/api/admin/drain")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.authorizeOrdersCancelled).toBe(7);
    expect(res.body.privateOrdersCancelled).toBeUndefined();
  });
});

describe("/api/admin/sanctions", () => {
  afterEach(clearSanctionedPubKeys);

  it("GET returns empty list by default", async () => {
    const res = await request(buildApp())
      .get("/api/admin/sanctions")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, entries: [] });
  });

  it("POST with empty body.entries returns 400", async () => {
    const res = await request(buildApp())
      .post("/api/admin/sanctions")
      .set("x-admin-key", ADMIN_KEY)
      .send({ entries: [] });
    expect(res.status).toBe(400);
  });

  it("POST with malformed entry returns 400 with invalidIndices (no 500)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/sanctions")
      .set("x-admin-key", ADMIN_KEY)
      .send({ entries: [
        { pubKeyAx: "1", pubKeyAy: "2" },
        { pubKeyAx: "not-a-bigint", pubKeyAy: "2" },
      ] });
    expect(res.status).toBe(400);
    expect(res.body.invalidIndices).toEqual([1]);
    // Up-front validation: a single malformed entry must leave the list untouched.
    const list = await request(app)
      .get("/api/admin/sanctions")
      .set("x-admin-key", ADMIN_KEY);
    expect(list.body.count).toBe(0);
  });

  it("POST valid entries, then GET returns them, then DELETE removes them", async () => {
    const app = buildApp();
    const addRes = await request(app)
      .post("/api/admin/sanctions")
      .set("x-admin-key", ADMIN_KEY)
      .send({ entries: [
        { pubKeyAx: "007", pubKeyAy: "010" },
        { pubKeyAx: "1", pubKeyAy: "2" },
        { pubKeyAx: "1", pubKeyAy: "2" },
      ] });
    expect(addRes.status).toBe(200);
    expect(addRes.body.added).toBe(2);

    const list = await request(app).get("/api/admin/sanctions").set("x-admin-key", ADMIN_KEY);
    expect(list.body.count).toBe(2);

    const delRes = await request(app)
      .delete("/api/admin/sanctions")
      .set("x-admin-key", ADMIN_KEY)
      .send({ entries: [{ pubKeyAx: "1", pubKeyAy: "2" }] });
    expect(delRes.status).toBe(200);
    expect(delRes.body.removed).toBe(1);
  });

  it("DELETE with malformed entry returns 400 (no 500)", async () => {
    const res = await request(buildApp())
      .delete("/api/admin/sanctions")
      .set("x-admin-key", ADMIN_KEY)
      .send({ entries: [{ pubKeyAx: "xyz", pubKeyAy: "1" }] });
    expect(res.status).toBe(400);
    expect(res.body.invalidIndices).toEqual([0]);
  });
});

describe("/api/admin/profile", () => {
  it("GET returns {} by default", async () => {
    const res = await request(buildApp()).get("/api/admin/profile").set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("PATCH persists fields + sets updatedAt + subsequent GET returns them", async () => {
    const db = makeDbStub();
    const app = buildApp({ db });

    const patchRes = await request(app)
      .patch("/api/admin/profile")
      .set("x-admin-key", ADMIN_KEY)
      .send({ name: "Acme Relayer", website: "https://acme.example" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe("Acme Relayer");
    expect(patchRes.body.website).toBe("https://acme.example");
    expect(typeof patchRes.body.updatedAt).toBe("number");

    const getRes = await request(app).get("/api/admin/profile").set("x-admin-key", ADMIN_KEY);
    expect(getRes.body.name).toBe("Acme Relayer");
    expect(getRes.body.website).toBe("https://acme.example");
  });

  it("PATCH merges — absent fields preserve, empty string clears", async () => {
    const db = makeDbStub();
    const app = buildApp({ db });

    await request(app).patch("/api/admin/profile").set("x-admin-key", ADMIN_KEY)
      .send({ name: "First", description: "Desc" });

    await request(app).patch("/api/admin/profile").set("x-admin-key", ADMIN_KEY)
      .send({ description: "" }); // clear description only

    const res = await request(app).get("/api/admin/profile").set("x-admin-key", ADMIN_KEY);
    expect(res.body.name).toBe("First");
    expect(res.body.description).toBeUndefined();
  });

  it("PATCH rejects non-string fields with 400", async () => {
    const res = await request(buildApp())
      .patch("/api/admin/profile")
      .set("x-admin-key", ADMIN_KEY)
      .send({ name: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
  });

  it("PATCH rejects over-length field with 400", async () => {
    const longName = "x".repeat(100);
    const res = await request(buildApp())
      .patch("/api/admin/profile")
      .set("x-admin-key", ADMIN_KEY)
      .send({ name: longName });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds/);
  });

  it("PATCH rejects logoUrl with disallowed scheme", async () => {
    const res = await request(buildApp())
      .patch("/api/admin/profile")
      .set("x-admin-key", ADMIN_KEY)
      .send({ logoUrl: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheme|URL/i);
  });

  it("PATCH accepts ipfs:// logoUrl", async () => {
    const res = await request(buildApp())
      .patch("/api/admin/profile")
      .set("x-admin-key", ADMIN_KEY)
      .send({ logoUrl: "ipfs://bafy.../logo.png" });
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBe("ipfs://bafy.../logo.png");
  });

  it("PATCH requires admin auth", async () => {
    const res = await request(buildApp())
      .patch("/api/admin/profile")
      .send({ name: "nope" });
    expect(res.status).toBe(401);
  });
});

describe("/api/admin/webhook", () => {
  it("GET returns configured flag + health + balance + settlement-failure streak + recent", async () => {
    const res = await request(buildApp())
      .get("/api/admin/webhook")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(typeof res.body.configured).toBe("boolean");
    expect(res.body.health).toHaveProperty("state");
    expect(res.body.health).toHaveProperty("at");
    expect(res.body.balance).toHaveProperty("state");
    expect(res.body.balance).toHaveProperty("thresholdWei");
    expect(typeof res.body.balance.thresholdWei).toBe("string");
    expect(res.body.settlementFailureStreak).toEqual({
      consecutiveFailures: expect.any(Number),
      alerted: expect.any(Boolean),
      threshold: expect.any(Number),
    });
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it("requires admin auth", async () => {
    const res = await request(buildApp()).get("/api/admin/webhook");
    expect(res.status).toBe(401);
  });

  it("POST /webhook/test returns 409 when no URL configured", async () => {
    // Test setup has no WEBHOOK_URL — the test endpoint short-circuits.
    const res = await request(buildApp())
      .post("/api/admin/webhook/test")
      .set("x-admin-key", ADMIN_KEY)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/WEBHOOK_URL/);
  });
});
