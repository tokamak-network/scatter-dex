/**
 * Regression coverage for the `/api/vault` DoS guard: each cache miss fans
 * out 2 + |TOKEN_LIST| `eth_call`s, so the route caches its on-chain snapshot
 * for a few seconds with single-flight coalescing. Without it, a flood of
 * unauthenticated GETs would amplify into the relayer's metered RPC quota.
 *
 * The mock Contract methods increment hoisted counters so we can assert how
 * many on-chain reads a burst of requests actually triggers.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mountRouter, makeSubmitterStub } from "./helpers.js";

const counters = vi.hoisted(() => ({ fee: 0 }));

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  const MockContract = vi.fn().mockImplementation(() => ({
    platformFeeBps: async () => { counters.fee++; return 100n; },
    treasury: async () => "0x" + "7".repeat(40),
    balances: async () => 42n,
  }));
  return { ...actual, Contract: MockContract, ethers: { ...actual.ethers, Contract: MockContract } };
});

const TOKEN_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let createVaultRoutes: typeof import("../../src/routes/vault.js").createVaultRoutes;

// Capture the ambient TOKEN_LIST so overriding it here can't clobber a value
// set by CI / other suites in a shared process.
const originalTokenList = process.env.TOKEN_LIST;

beforeAll(async () => {
  vi.resetModules();
  process.env.TOKEN_LIST = `${TOKEN_ADDR}:USDT:6`;
  ({ createVaultRoutes } = await import("../../src/routes/vault.js"));
});

afterAll(() => {
  if (originalTokenList === undefined) {
    delete process.env.TOKEN_LIST;
  } else {
    process.env.TOKEN_LIST = originalTokenList;
  }
});

describe("GET /api/vault caching", () => {
  it("coalesces a concurrent burst into a single on-chain fan-out, then serves from cache", async () => {
    counters.fee = 0;
    const app = mountRouter("/api/vault", createVaultRoutes(makeSubmitterStub()));

    // Concurrent burst — single-flight means only the first miss reads chain.
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get("/api/vault")),
    );
    for (const res of burst) {
      expect(res.status).toBe(200);
      expect(res.body.platformFeeBps).toBe(100);
    }
    expect(counters.fee).toBe(1);

    // A follow-up request within the TTL is a cache hit — still one read.
    const again = await request(app).get("/api/vault");
    expect(again.status).toBe(200);
    expect(counters.fee).toBe(1);
  });
});
