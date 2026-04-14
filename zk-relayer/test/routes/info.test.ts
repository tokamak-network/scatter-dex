import { describe, it, expect } from "vitest";
import request from "supertest";
import { createInfoRoutes } from "../../src/routes/info.js";
import { mountRouter, makeSubmitterStub } from "./helpers.js";

describe("/api/info", () => {
  it("GET / returns relayer metadata", async () => {
    const app = mountRouter("/api/info", createInfoRoutes(makeSubmitterStub()));
    const res = await request(app).get("/api/info");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("ScatterDEX ZK Relayer");
    expect(typeof res.body.orderCount).toBe("number"); // authorize map size
    expect(res.body.address).toMatch(/^0x/);
  });

  it("GET /merkle-proof returns proof for valid leafIndex", async () => {
    const app = mountRouter("/api/info", createInfoRoutes(makeSubmitterStub()));
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=3");
    expect(res.status).toBe(200);
    expect(res.body.leafIndex).toBe(3);
  });

  it("GET /merkle-proof rejects missing leafIndex with 400", async () => {
    const app = mountRouter("/api/info", createInfoRoutes(makeSubmitterStub()));
    const res = await request(app).get("/api/info/merkle-proof");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/leafIndex/i);
  });

  it("GET /merkle-proof rejects negative leafIndex with 400", async () => {
    const app = mountRouter("/api/info", createInfoRoutes(makeSubmitterStub()));
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=-1");
    expect(res.status).toBe(400);
  });

  it("GET /merkle-proof returns 500 when submitter throws", async () => {
    const submitter = makeSubmitterStub({
      getCommitmentMerkleProof: async () => { throw new Error("rpc failed"); },
    });
    const app = mountRouter("/api/info", createInfoRoutes(submitter));
    const res = await request(app).get("/api/info/merkle-proof?leafIndex=0");
    expect(res.status).toBe(500);
  });
});
