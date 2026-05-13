import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createInfoRoutes } from "../../src/routes/info.js";
import { mountRouter, makeSubmitterStub, makeDbStub } from "./helpers.js";

describe("/api/info", () => {
  it("GET / returns relayer metadata", async () => {
    // Force a known RELAYER_NAME + reimport so the assertion can pin
    // to an exact value rather than re-deriving the route's own logic.
    // Same module-cache dance as the CLAIM_FEE test below, with the
    // catch that config.ts calls `dotenv.config()` at module init — so
    // we have to overwrite (not delete) the env var to win against
    // whatever `.env` provides.
    const savedName = process.env.RELAYER_NAME;
    process.env.RELAYER_NAME = "test-relayer-info-route";
    try {
      vi.resetModules();
      const { createInfoRoutes: freshCreateInfoRoutes } = await import(
        "../../src/routes/info.js"
      );
      const app = mountRouter(
        "/api/info",
        freshCreateInfoRoutes(makeSubmitterStub(), makeDbStub()),
      );
      const res = await request(app).get("/api/info");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("test-relayer-info-route");
      expect(typeof res.body.orderCount).toBe("number"); // authorize map size
      expect(res.body.address).toMatch(/^0x/);
    } finally {
      if (savedName === undefined) delete process.env.RELAYER_NAME;
      else process.env.RELAYER_NAME = savedName;
    }
  });

  it("GET / publishes claim_fees from CLAIM_FEE_<SYMBOL> envs", async () => {
    // config.ts reads `process.env` at module load, so swap in the
    // CLAIM_FEE_* values, drop the module cache, then dynamic-import
    // the route. Restore the prior env in `finally` so other tests
    // see the original process state.
    const savedUSDC = process.env.CLAIM_FEE_USDC;
    const savedTON = process.env.CLAIM_FEE_TON;
    process.env.CLAIM_FEE_USDC = "0.07";
    process.env.CLAIM_FEE_TON = "0.5";
    try {
      vi.resetModules();
      const { createInfoRoutes: freshCreateInfoRoutes } = await import(
        "../../src/routes/info.js"
      );
      const app = mountRouter(
        "/api/info",
        freshCreateInfoRoutes(makeSubmitterStub(), makeDbStub()),
      );
      const res = await request(app).get("/api/info");
      expect(res.status).toBe(200);
      // Subset assertion — the .env file may already define
      // CLAIM_FEE_<other> values; we only care that the fields we
      // injected end up in the published map with the right values.
      expect(res.body.claim_fees).toMatchObject({ USDC: "0.07", TON: "0.5" });
    } finally {
      if (savedUSDC === undefined) delete process.env.CLAIM_FEE_USDC;
      else process.env.CLAIM_FEE_USDC = savedUSDC;
      if (savedTON === undefined) delete process.env.CLAIM_FEE_TON;
      else process.env.CLAIM_FEE_TON = savedTON;
    }
  });

  it("GET /merkle-proof returns proof for valid leafIndex", async () => {
    const app = mountRouter("/api/info", createInfoRoutes(makeSubmitterStub(), makeDbStub()));
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=3");
    expect(res.status).toBe(200);
    expect(res.body.leafIndex).toBe(3);
  });

  it("GET /merkle-proof rejects missing leafIndex with 400", async () => {
    const app = mountRouter("/api/info", createInfoRoutes(makeSubmitterStub(), makeDbStub()));
    const res = await request(app).get("/api/info/merkle-proof");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/leafIndex/i);
  });

  it("GET /merkle-proof rejects negative leafIndex with 400", async () => {
    const app = mountRouter("/api/info", createInfoRoutes(makeSubmitterStub(), makeDbStub()));
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=-1");
    expect(res.status).toBe(400);
  });

  it("GET /merkle-proof returns 500 when submitter throws", async () => {
    const submitter = makeSubmitterStub({
      getCommitmentMerkleProof: async () => { throw new Error("rpc failed"); },
    });
    const app = mountRouter("/api/info", createInfoRoutes(submitter, makeDbStub()));
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=0");
    expect(res.status).toBe(500);
  });
});
