import { describe, it, expect } from "vitest";
import request from "supertest";
import { createPrivateClaimRoutes } from "../../src/routes/claim.js";
import { mountRouter, makeSubmitterStub, makeDbStub } from "./helpers.js";

const VALID_PROOF = {
  proofA: ["1", "2"],
  proofB: [["3", "4"], ["5", "6"]],
  proofC: ["7", "8"],
  claimsRoot: "0x" + "a".repeat(64),
  claimNullifier: "0x" + "b".repeat(64),
  amount: "1000",
  token: "0x" + "c".repeat(40),
  recipient: "0x" + "d".repeat(40),
  releaseTime: "123456",
};

function buildApp(db = makeDbStub({ hasSettledClaimsRoot: () => true }), submitter = makeSubmitterStub()) {
  return mountRouter("/api/private-claim", createPrivateClaimRoutes(submitter, db));
}

describe("POST /api/private-claim", () => {
  it("rejects missing required fields with 400", async () => {
    const res = await request(buildApp())
      .post("/api/private-claim")
      .send({ proofA: ["1", "2"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
  });

  it("rejects proofB with wrong outer length with 400", async () => {
    const res = await request(buildApp())
      .post("/api/private-claim")
      .send({ ...VALID_PROOF, proofB: [["3", "4"]] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/proofB/i);
  });

  it("rejects hex string with wrong length (claimsRoot)", async () => {
    const res = await request(buildApp())
      .post("/api/private-claim")
      .send({ ...VALID_PROOF, claimsRoot: "0xabc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/claimsRoot/i);
  });

  it("rejects recipient with non-hex chars", async () => {
    const res = await request(buildApp())
      .post("/api/private-claim")
      .send({ ...VALID_PROOF, recipient: "0x" + "z".repeat(40) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recipient/i);
  });

  it("returns 403 when claimsRoot is not settled by this relayer", async () => {
    const db = makeDbStub({ hasSettledClaimsRoot: () => false });
    const res = await request(buildApp(db))
      .post("/api/private-claim")
      .send(VALID_PROOF);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/settled/i);
  });

  it("returns 400 when amount is not BigInt-parseable", async () => {
    const res = await request(buildApp())
      .post("/api/private-claim")
      .send({ ...VALID_PROOF, amount: "not-a-bigint" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with txHash on success", async () => {
    const submitter = makeSubmitterStub({
      submitClaim: async () => "0x" + "1".repeat(64),
    });
    const res = await request(buildApp(undefined, submitter))
      .post("/api/private-claim")
      .send(VALID_PROOF);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("claimed");
    expect(res.body.txHash).toBe("0x" + "1".repeat(64));
  });

  it("maps 'nullifier already spent' submitter error to 400", async () => {
    const submitter = makeSubmitterStub({
      submitClaim: async () => { throw new Error("nullifier already spent"); },
    });
    const res = await request(buildApp(undefined, submitter))
      .post("/api/private-claim")
      .send(VALID_PROOF);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nullifier/i);
  });

  it("maps unknown submitter error to generic 500", async () => {
    const submitter = makeSubmitterStub({
      submitClaim: async () => { throw new Error("rpc down"); },
    });
    const res = await request(buildApp(undefined, submitter))
      .post("/api/private-claim")
      .send(VALID_PROOF);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("claim failed");
  });
});
