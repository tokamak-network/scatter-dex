import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { ethers } from "ethers";
import { createAdminRoutes } from "../../src/routes/admin.js";
import { clearSanctionedPubKeys } from "../../src/core/sanctions-list.js";
import { config, updateRelayerFee } from "../../src/config.js";
import { mountRouter, makeSubmitterStub, makeDbStub, siweLogin } from "./helpers.js";

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

// Build an admin app and mint an operator SIWE bearer against it. Login
// must follow this app's build — `createAdminRoutes` publishes its SIWE
// handle as the process singleton, so the most-recently-built app owns the
// active session store.
async function buildAuthedApp(opts: Parameters<typeof buildApp>[0] = {}) {
  const app = buildApp(opts);
  const auth = await siweLogin(app);
  return { app, auth };
}

describe("/api/admin — auth (SIWE)", () => {
  it("rejects a request with no Authorization header with 401", async () => {
    const res = await request(buildApp()).get("/api/admin/status");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/bearer/i);
  });

  it("rejects a malformed / unknown bearer token with 401", async () => {
    const res = await request(buildApp())
      .get("/api/admin/status")
      .set("Authorization", "Bearer " + "ff".repeat(32));
    expect(res.status).toBe(401);
  });

  it("rejects a session signed by a non-operator wallet with 401", async () => {
    // The challenge is public, but only the node's operator wallet can mint
    // a session — a different signer is rejected at /session.
    const app = buildApp();
    const ch = await request(app).get("/api/admin/challenge");
    const stranger = ethers.Wallet.createRandom();
    const signature = await stranger.signMessage(ch.body.message);
    const sess = await request(app)
      .post("/api/admin/session")
      .send({ nonce: ch.body.nonce, message: ch.body.message, signature });
    expect(sess.status).toBe(401);
    expect(sess.body.error).toMatch(/operator/i);
  });

  it("accepts a valid operator SIWE session and returns 200", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app).get("/api/admin/status").set("Authorization", auth);
    expect(res.status).toBe(200);
  });
});

describe("/api/admin/status + /balance", () => {
  it("GET /status includes relayer config + paused state + authorizeOrders", async () => {
    const app = buildApp({
      getAuthorizeOrderStats: () => ({ pending: 5, matched: 2, total: 7 }),
    });
    const auth = await siweLogin(app);
    const res = await request(app)
      .get("/api/admin/status")
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.authorizeOrders).toEqual({ pending: 5, matched: 2, total: 7 });
    expect(res.body.privateOrders).toBeUndefined();
    expect(res.body.feeBps).toBeTypeOf("number");
  });

  it("GET /balance returns wallet + chainId", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .get("/api/admin/balance")
      .set("Authorization", auth);
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
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .put("/api/admin/fee")
      .set("Authorization", auth)
      .send({ feeBps: 12.5 });
    expect(res.status).toBe(400);
  });

  it("rejects out-of-range (>10000) with 400", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .put("/api/admin/fee")
      .set("Authorization", auth)
      .send({ feeBps: 10001 });
    expect(res.status).toBe(400);
  });

  it("rejects negative with 400", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .put("/api/admin/fee")
      .set("Authorization", auth)
      .send({ feeBps: -1 });
    expect(res.status).toBe(400);
  });

  it("accepts valid feeBps and persists via db.setMeta", async () => {
    const setMetaCalls: Array<[string, string]> = [];
    const db = makeDbStub({ setMeta: (k: string, v: string) => { setMetaCalls.push([k, v]); } });
    const { app, auth } = await buildAuthedApp({ db });
    const res = await request(app)
      .put("/api/admin/fee")
      .set("Authorization", auth)
      .send({ feeBps: 55 });
    expect(res.status).toBe(200);
    expect(res.body.newFeeBps).toBe(55);
    expect(setMetaCalls).toContainEqual(["relayerFee", "55"]);
  });
});

describe("/api/admin/pause + /resume", () => {
  it("pause → resume is a valid cycle; double-pause / double-resume return 409", async () => {
    const { app, auth } = await buildAuthedApp();
    let res = await request(app).post("/api/admin/pause").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");

    res = await request(app).post("/api/admin/pause").set("Authorization", auth);
    expect(res.status).toBe(409);

    res = await request(app).post("/api/admin/resume").set("Authorization", auth);
    expect(res.status).toBe(200);

    res = await request(app).post("/api/admin/resume").set("Authorization", auth);
    expect(res.status).toBe(409);
  });
});

describe("/api/admin/drain", () => {
  it("returns count from authorize drain", async () => {
    const { app, auth } = await buildAuthedApp({ drainAuthorizeOrders: () => 7 });
    const res = await request(app)
      .post("/api/admin/drain")
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.authorizeOrdersCancelled).toBe(7);
    expect(res.body.privateOrdersCancelled).toBeUndefined();
  });
});

describe("/api/admin/sanctions", () => {
  afterEach(clearSanctionedPubKeys);

  it("GET returns empty list by default", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .get("/api/admin/sanctions")
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, entries: [] });
  });

  it("POST with empty body.entries returns 400", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .post("/api/admin/sanctions")
      .set("Authorization", auth)
      .send({ entries: [] });
    expect(res.status).toBe(400);
  });

  it("POST with malformed entry returns 400 with invalidIndices (no 500)", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .post("/api/admin/sanctions")
      .set("Authorization", auth)
      .send({ entries: [
        { pubKeyAx: "1", pubKeyAy: "2" },
        { pubKeyAx: "not-a-bigint", pubKeyAy: "2" },
      ] });
    expect(res.status).toBe(400);
    expect(res.body.invalidIndices).toEqual([1]);
    // Up-front validation: a single malformed entry must leave the list untouched.
    const list = await request(app)
      .get("/api/admin/sanctions")
      .set("Authorization", auth);
    expect(list.body.count).toBe(0);
  });

  it("POST valid entries, then GET returns them, then DELETE removes them", async () => {
    const { app, auth } = await buildAuthedApp();
    const addRes = await request(app)
      .post("/api/admin/sanctions")
      .set("Authorization", auth)
      .send({ entries: [
        { pubKeyAx: "007", pubKeyAy: "010" },
        { pubKeyAx: "1", pubKeyAy: "2" },
        { pubKeyAx: "1", pubKeyAy: "2" },
      ] });
    expect(addRes.status).toBe(200);
    expect(addRes.body.added).toBe(2);

    const list = await request(app).get("/api/admin/sanctions").set("Authorization", auth);
    expect(list.body.count).toBe(2);

    const delRes = await request(app)
      .delete("/api/admin/sanctions")
      .set("Authorization", auth)
      .send({ entries: [{ pubKeyAx: "1", pubKeyAy: "2" }] });
    expect(delRes.status).toBe(200);
    expect(delRes.body.removed).toBe(1);
  });

  it("DELETE with malformed entry returns 400 (no 500)", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .delete("/api/admin/sanctions")
      .set("Authorization", auth)
      .send({ entries: [{ pubKeyAx: "xyz", pubKeyAy: "1" }] });
    expect(res.status).toBe(400);
    expect(res.body.invalidIndices).toEqual([0]);
  });
});

describe("/api/admin/profile", () => {
  it("GET returns {} by default", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app).get("/api/admin/profile").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("PATCH persists fields + sets updatedAt + subsequent GET returns them", async () => {
    const db = makeDbStub();
    const { app, auth } = await buildAuthedApp({ db });

    const patchRes = await request(app)
      .patch("/api/admin/profile")
      .set("Authorization", auth)
      .send({ name: "Acme Relayer", website: "https://acme.example" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe("Acme Relayer");
    expect(patchRes.body.website).toBe("https://acme.example");
    expect(typeof patchRes.body.updatedAt).toBe("number");

    const getRes = await request(app).get("/api/admin/profile").set("Authorization", auth);
    expect(getRes.body.name).toBe("Acme Relayer");
    expect(getRes.body.website).toBe("https://acme.example");
  });

  it("PATCH merges — absent fields preserve, empty string clears", async () => {
    const db = makeDbStub();
    const { app, auth } = await buildAuthedApp({ db });

    await request(app).patch("/api/admin/profile").set("Authorization", auth)
      .send({ name: "First", description: "Desc" });

    await request(app).patch("/api/admin/profile").set("Authorization", auth)
      .send({ description: "" }); // clear description only

    const res = await request(app).get("/api/admin/profile").set("Authorization", auth);
    expect(res.body.name).toBe("First");
    expect(res.body.description).toBeUndefined();
  });

  it("PATCH rejects non-string fields with 400", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .patch("/api/admin/profile")
      .set("Authorization", auth)
      .send({ name: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
  });

  it("PATCH rejects over-length field with 400", async () => {
    const longName = "x".repeat(100);
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .patch("/api/admin/profile")
      .set("Authorization", auth)
      .send({ name: longName });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds/);
  });

  it("PATCH rejects logoUrl with disallowed scheme", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .patch("/api/admin/profile")
      .set("Authorization", auth)
      .send({ logoUrl: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheme|URL/i);
  });

  it("PATCH accepts ipfs:// logoUrl", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .patch("/api/admin/profile")
      .set("Authorization", auth)
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
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .get("/api/admin/webhook")
      .set("Authorization", auth);
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
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .post("/api/admin/webhook/test")
      .set("Authorization", auth)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/WEBHOOK_URL/);
  });
});

describe("/api/admin/history.csv", () => {
  const sampleRow = {
    id: 1,
    tx_hash: "0xabc",
    type: "settleAuth",
    status: "confirmed",
    block_number: 100,
    gas_cost_eth: "0.001",
    sell_token: "0xToken,with,comma",
    buy_token: "0xToken\"with\"quote",
    error_reason: null,
    duration_ms: 1500,
    created_at: 1_700_000_000_000,
  };

  it("rejects missing admin auth", async () => {
    const res = await request(buildApp()).get("/api/admin/history.csv");
    expect(res.status).toBe(401);
  });

  it("emits CSV with header + escaped cells, and Content-Disposition", async () => {
    const calls: Array<{ since: number; until: number; type?: string; status?: string }> = [];
    const db = makeDbStub({
      iterateSettlementHistoryRange: (opts) => {
        calls.push(opts);
        return [sampleRow];
      },
    });
    const { app, auth } = await buildAuthedApp({ db });
    const res = await request(app)
      .get("/api/admin/history.csv?since=0&until=1700000001000")
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=".*\.csv"/);

    // res.text — not .trim(), since trim strips the leading BOM that
    // we want to verify. The BOM is what Excel reads to detect UTF-8.
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    const lines = res.text.split("\n").filter((l) => l.length > 0);
    expect(lines[0].slice(1)).toBe("id,tx_hash,type,status,block_number,gas_cost_eth,sell_token,buy_token,error_reason,duration_ms,created_at,created_at_iso");
    // Token with comma must be quoted; token with double-quote must be quoted + doubled-up.
    expect(lines[1]).toContain('"0xToken,with,comma"');
    expect(lines[1]).toContain('"0xToken""with""quote"');
    // Null error_reason is rendered as empty cell.
    expect(lines[1]).toMatch(/,,1500,/);
    expect(calls[0]).toMatchObject({ since: 0, until: 1_700_000_001_000 });
  });

  it("forwards type/status filters to the iterator", async () => {
    const calls: Array<{ type?: string; status?: string }> = [];
    const db = makeDbStub({
      iterateSettlementHistoryRange: (opts) => { calls.push(opts); return []; },
    });
    const { app, auth } = await buildAuthedApp({ db });
    await request(app)
      .get("/api/admin/history.csv?type=settleAuth&status=failed")
      .set("Authorization", auth);
    expect(calls[0]).toMatchObject({ type: "settleAuth", status: "failed" });
  });

  it("ignores invalid type/status values (treats as undefined)", async () => {
    const calls: Array<{ type?: string; status?: string }> = [];
    const db = makeDbStub({
      iterateSettlementHistoryRange: (opts) => { calls.push(opts); return []; },
    });
    const { app, auth } = await buildAuthedApp({ db });
    await request(app)
      .get("/api/admin/history.csv?type=BOGUS&status=alsobogus")
      .set("Authorization", auth);
    expect(calls[0].type).toBeUndefined();
    expect(calls[0].status).toBeUndefined();
  });

  it("returns 400 when until < since", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .get("/api/admin/history.csv?since=2000&until=1000")
      .set("Authorization", auth);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/until/);
  });

  it("emits header + zero rows when window is empty", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .get("/api/admin/history.csv")
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.text.trim().split("\n")).toHaveLength(1);
  });
});

describe("/api/admin/orders/by-tx/:txHash/proof", () => {
  const validHash = "0x" + "ab".repeat(32);
  const decoyCalldata = "0xdeadbeef" + "00".repeat(32);

  it("rejects malformed txHash with 400", async () => {
    const { app, auth } = await buildAuthedApp();
    const res = await request(app)
      .get("/api/admin/orders/by-tx/not-a-hash/proof")
      .set("Authorization", auth);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the provider has no record of the tx", async () => {
    const router = createAdminRoutes({
      submitter: makeSubmitterStub(), db: makeDbStub(),
      drainAuthorizeOrders: () => 0,
      getAuthorizeOrderStats: () => ({ pending: 0, matched: 0, total: 0 }),
    });
    const app = mountRouter("/api/admin", router);
    const auth = await siweLogin(app);
    const res = await request(app)
      .get(`/api/admin/orders/by-tx/${validHash}/proof`)
      .set("Authorization", auth);
    expect(res.status).toBe(404);
  });

  it("returns calldata + null decoded for an unknown function selector", async () => {
    const submitter = makeSubmitterStub({
      getProvider: () => ({
        getBlockNumber: async () => 1, getBalance: async () => 0n, getNetwork: async () => ({ chainId: 1n }),
        getTransaction: async () => ({ data: decoyCalldata, from: "0xfrom", to: "0xto", blockNumber: 999 }),
      }),
    });
    const router = createAdminRoutes({
      submitter, db: makeDbStub(),
      drainAuthorizeOrders: () => 0,
      getAuthorizeOrderStats: () => ({ pending: 0, matched: 0, total: 0 }),
    });
    const app = mountRouter("/api/admin", router);
    const auth = await siweLogin(app);
    const res = await request(app)
      .get(`/api/admin/orders/by-tx/${validHash}/proof`)
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.decoded).toBeNull();
    expect(res.body.calldata).toBe(decoyCalldata);
    expect(res.body.from).toBe("0xfrom");
    expect(res.body.blockNumber).toBe(999);
  });
});
