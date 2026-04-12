// Force TOKEN_LIST to a known single entry before importing vault.ts (which
// parses it at module load). Override any value already set via `.env`.
process.env.TOKEN_LIST = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:USDT:6";

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createVaultRoutes } from "../../src/routes/vault.js";
import { mountRouter, makeSubmitterStub } from "./helpers.js";

// Mock ethers.Contract so vault.ts's FEE_VAULT_ABI queries resolve without
// a real provider. vault.ts uses the `ethers` namespace import, so the
// namespace's `Contract` must be overridden alongside the top-level one.
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  const MockContract = vi.fn().mockImplementation(() => ({
    platformFeeBps: async () => 100n,
    treasury: async () => "0x" + "7".repeat(40),
    balances: async () => 42n,
  }));
  return {
    ...actual,
    Contract: MockContract,
    ethers: { ...actual.ethers, Contract: MockContract },
  };
});

const ADMIN_KEY = process.env.ADMIN_API_KEY as string;

function buildApp(submitter = makeSubmitterStub()) {
  return mountRouter("/api/vault", createVaultRoutes(submitter));
}

describe("GET /api/vault", () => {
  it("returns vault metadata + token balances (200)", async () => {
    const res = await request(buildApp()).get("/api/vault");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.platformFeeBps).toBe(100);
    expect(res.body.treasury).toMatch(/^0x7+$/);
    // All entries should use the mocked `balances` return (42n → "42")
    expect(res.body.balances.length).toBeGreaterThan(0);
    for (const b of res.body.balances) {
      expect(b.balance).toBe("42");
      expect(typeof b.token).toBe("string");
    }
  });
});

describe("POST /api/vault/claim", () => {
  it("rejects request without x-admin-key with 401", async () => {
    const res = await request(buildApp()).post("/api/vault/claim").send({ token: "0x" + "a".repeat(40) });
    expect(res.status).toBe(401);
  });

  it("rejects invalid token address with 400", async () => {
    const res = await request(buildApp())
      .post("/api/vault/claim")
      .set("x-admin-key", ADMIN_KEY)
      .send({ token: "not-an-address" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  it("rejects missing token with 400", async () => {
    const res = await request(buildApp())
      .post("/api/vault/claim")
      .set("x-admin-key", ADMIN_KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 200 with txHash on success", async () => {
    const submitter = makeSubmitterStub({
      claimVaultFee: async () => "0x" + "1".repeat(64),
    });
    const res = await request(buildApp(submitter))
      .post("/api/vault/claim")
      .set("x-admin-key", ADMIN_KEY)
      .send({ token: "0x" + "a".repeat(40) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("claimed");
    expect(res.body.txHash).toBe("0x" + "1".repeat(64));
  });

  it("maps 'No fees to claim' submitter error to 400", async () => {
    const submitter = makeSubmitterStub({
      claimVaultFee: async () => { throw new Error("No fees to claim"); },
    });
    const res = await request(buildApp(submitter))
      .post("/api/vault/claim")
      .set("x-admin-key", ADMIN_KEY)
      .send({ token: "0x" + "a".repeat(40) });
    expect(res.status).toBe(400);
  });

  it("maps other submitter errors to 500", async () => {
    const submitter = makeSubmitterStub({
      claimVaultFee: async () => { throw new Error("rpc down"); },
    });
    const res = await request(buildApp(submitter))
      .post("/api/vault/claim")
      .set("x-admin-key", ADMIN_KEY)
      .send({ token: "0x" + "a".repeat(40) });
    expect(res.status).toBe(500);
  });
});
