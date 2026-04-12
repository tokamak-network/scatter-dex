import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { mountRouter, makeSubmitterStub } from "./helpers.js";

// Mock ethers.Contract before vault.ts is imported. Override both the
// top-level export and the `ethers` namespace-scoped one since vault.ts
// uses `import { ethers } from "ethers"` then `new ethers.Contract(...)`.
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  const MockContract = vi.fn().mockImplementation(() => ({
    platformFeeBps: async () => 100n,
    treasury: async () => "0x" + "7".repeat(40),
    balances: async () => 42n,
  }));
  return { ...actual, Contract: MockContract, ethers: { ...actual.ethers, Contract: MockContract } };
});

const ADMIN_KEY = process.env.ADMIN_API_KEY as string;

// vault.ts parses TOKEN_LIST at module load, so control it via
// resetModules + dynamic import. This keeps the test hermetic regardless
// of any `.env` TOKEN_LIST value.
const TOKEN_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let createVaultRoutes: typeof import("../../src/routes/vault.js").createVaultRoutes;

beforeAll(async () => {
  vi.resetModules();
  process.env.TOKEN_LIST = `${TOKEN_ADDR}:USDT:6`;
  ({ createVaultRoutes } = await import("../../src/routes/vault.js"));
});

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
    expect(res.body.balances).toEqual([
      { token: TOKEN_ADDR, symbol: "USDT", decimals: 6, balance: "42" },
    ]);
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
