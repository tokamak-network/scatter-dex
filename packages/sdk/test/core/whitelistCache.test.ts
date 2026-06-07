import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock ethers.Contract like whitelist.test so the cached fetch runs the
// real fetchWhitelistedTokens against an in-memory chain. `getterCalls`
// counts getWhitelistedTokens() invocations (2 per underlying fetch:
// pool + settlement) so we can assert cache hits vs misses.
let getterCalls = 0;
let contractHandler: (address: string) => unknown;

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class MockContract {
    constructor(address: string) {
      return contractHandler(address) as object;
    }
  }
  return { ...actual, ethers: { ...actual.ethers, Contract: MockContract } };
});

import {
  fetchWhitelistedTokensCached,
  invalidateWhitelistCache,
} from "../../src/core/whitelistCache";

const POOL = "0x" + "1".repeat(40);
const SET = "0x" + "2".repeat(40);
const POOL2 = "0x" + "3".repeat(40);
const B = "0x" + "b".repeat(40);

const provider = {} as never;

function defaultChain() {
  contractHandler = (address: string) => {
    const addr = address.toLowerCase();
    if (addr === POOL.toLowerCase() || addr === POOL2.toLowerCase() || addr === SET.toLowerCase()) {
      return {
        getWhitelistedTokens: async () => {
          getterCalls++;
          return [B];
        },
      };
    }
    return {
      symbol: async () => "USDC",
      decimals: async () => 6n,
    };
  };
}

beforeEach(() => {
  invalidateWhitelistCache(); // clear cross-test state
  getterCalls = 0;
  defaultChain();
});

describe("fetchWhitelistedTokensCached", () => {
  it("serves a repeat read from cache without re-hitting the chain", async () => {
    const now = () => 1000;
    const a = await fetchWhitelistedTokensCached(provider, POOL, SET, { now });
    expect(getterCalls).toBe(2); // one underlying fetch (pool + settlement)
    expect(a).toEqual([{ address: B, symbol: "USDC", decimals: 6, isNative: false }]);

    const b = await fetchWhitelistedTokensCached(provider, POOL, SET, { now });
    expect(getterCalls).toBe(2); // cache hit — no new getter calls
    expect(b).toEqual(a);
  });

  it("de-duplicates concurrent reads into one in-flight fetch", async () => {
    const now = () => 1000;
    const [a, b] = await Promise.all([
      fetchWhitelistedTokensCached(provider, POOL, SET, { now }),
      fetchWhitelistedTokensCached(provider, POOL, SET, { now }),
    ]);
    expect(getterCalls).toBe(2); // shared, not 4
    expect(a).toEqual(b);
  });

  it("refetches once the TTL has elapsed", async () => {
    let t = 1000;
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now: () => t, ttlMs: 5000 });
    expect(getterCalls).toBe(2);

    t = 1000 + 5001; // past expiry (expires = 1000 + 5000)
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now: () => t, ttlMs: 5000 });
    expect(getterCalls).toBe(4);
  });

  it("keeps serving from cache just before the TTL elapses", async () => {
    let t = 1000;
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now: () => t, ttlMs: 5000 });
    t = 1000 + 4999; // still fresh
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now: () => t, ttlMs: 5000 });
    expect(getterCalls).toBe(2);
  });

  it("bypasses the cache when force is set", async () => {
    const now = () => 1000;
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now });
    expect(getterCalls).toBe(2);
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now, force: true });
    expect(getterCalls).toBe(4); // forced refetch despite a fresh entry
  });

  it("caches per (pool, settlement) — distinct keys don't collide", async () => {
    const now = () => 1000;
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now });
    await fetchWhitelistedTokensCached(provider, POOL2, SET, { now });
    expect(getterCalls).toBe(4); // two separate fetches
  });

  it("invalidateWhitelistCache forces the next read to refetch", async () => {
    const now = () => 1000;
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now });
    expect(getterCalls).toBe(2);
    invalidateWhitelistCache(POOL, SET);
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now });
    expect(getterCalls).toBe(4);
  });
});

describe("fetchWhitelistedTokensCached — sessionStorage tier", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    const fake: Storage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
      clear: () => store.clear(),
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };
    (globalThis as { window?: unknown }).window = { sessionStorage: fake };
    invalidateWhitelistCache();
    getterCalls = 0;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("serves a fresh sessionStorage entry without a fetch (survives a memory reset)", async () => {
    // Pre-seed sessionStorage as a prior page load would have, then clear
    // the in-memory tier to simulate a fresh module/page.
    const key = `${POOL.toLowerCase()}|${SET.toLowerCase()}`;
    store.set(
      "zkscatter.whitelist." + key,
      JSON.stringify({
        tokens: [{ address: B, symbol: "USDC", decimals: 6, isNative: false }],
        expires: 5000,
      }),
    );

    const r = await fetchWhitelistedTokensCached(provider, POOL, SET, { now: () => 1000 });
    expect(getterCalls).toBe(0); // served from sessionStorage
    expect(r[0].symbol).toBe("USDC");
  });

  it("ignores an expired sessionStorage entry and refetches", async () => {
    const key = `${POOL.toLowerCase()}|${SET.toLowerCase()}`;
    store.set(
      "zkscatter.whitelist." + key,
      JSON.stringify({ tokens: [], expires: 500 }), // expires < now
    );
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now: () => 1000 });
    expect(getterCalls).toBe(2);
  });

  it("writes successful reads through to sessionStorage", async () => {
    await fetchWhitelistedTokensCached(provider, POOL, SET, { now: () => 1000, ttlMs: 5000 });
    const key = `${POOL.toLowerCase()}|${SET.toLowerCase()}`;
    const raw = store.get("zkscatter.whitelist." + key);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.expires).toBe(6000); // now + ttl
    expect(parsed.tokens[0].symbol).toBe("USDC");
  });
});
