import { describe, it, expect } from "vitest";
import { makeRelayerMembership } from "../src/core/relayer-membership.js";

const ADDR = "0x" + "11".repeat(20);
const CHAIN = 11155111;

describe("makeRelayerMembership", () => {
  it("returns the injected check result", async () => {
    const yes = makeRelayerMembership([], { check: async () => true });
    const no = makeRelayerMembership([], { check: async () => false });
    expect(await yes.isActiveRelayer(CHAIN, ADDR)).toBe(true);
    expect(await no.isActiveRelayer(CHAIN, ADDR)).toBe(false);
  });

  it("caches a positive result for positiveTtlMs (check runs once)", async () => {
    let calls = 0;
    let clock = 1_000;
    const m = makeRelayerMembership([], {
      check: async () => { calls++; return true; },
      now: () => clock,
      positiveTtlMs: 100,
    });
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(true);
    clock += 50; // within TTL
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(true);
    expect(calls).toBe(1);
    clock += 100; // past TTL → re-check
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(true);
    expect(calls).toBe(2);
  });

  it("caches a negative result only for the short negativeTtlMs", async () => {
    let calls = 0;
    let clock = 1_000;
    const m = makeRelayerMembership([], {
      check: async () => { calls++; return false; },
      now: () => clock,
      positiveTtlMs: 10_000,
      negativeTtlMs: 20,
    });
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(false);
    clock += 10; // within negative TTL
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(false);
    expect(calls).toBe(1);
    clock += 30; // past negative TTL → a freshly-registered relayer re-checks soon
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(false);
    expect(calls).toBe(2);
  });

  it("fails open on a check error and does not cache the failure", async () => {
    let calls = 0;
    const m = makeRelayerMembership([], {
      check: async () => { calls++; throw new Error("rpc down"); },
    });
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(true); // allowed
    expect(await m.isActiveRelayer(CHAIN, ADDR)).toBe(true);
    expect(calls).toBe(2); // re-checked, not cached
  });

  it("keys the cache by (chainId, address) and lowercases the address", async () => {
    const seen: string[] = [];
    const m = makeRelayerMembership([], {
      check: async (chainId, relayer) => { seen.push(`${chainId}:${relayer}`); return true; },
    });
    await m.isActiveRelayer(CHAIN, ADDR.toUpperCase());
    await m.isActiveRelayer(CHAIN, ADDR.toUpperCase()); // cache hit (same key)
    await m.isActiveRelayer(1, ADDR); // different chain → miss
    expect(seen).toEqual([`${CHAIN}:${ADDR}`, `1:${ADDR}`]);
  });
});
