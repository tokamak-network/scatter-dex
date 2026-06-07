import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock `ethers.Contract` so the on-chain reads in fetchWhitelistedTokens
// run against an in-memory chain. Everything else in `ethers` (Interface,
// AbiCoder, …) stays real so contracts.ts's IFACE singletons still build.
//
// The mocked Contract constructor returns whatever `contractHandler`
// yields for that address — set per test via `setChain(...)`.
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

import { fetchWhitelistedTokens } from "../../src/core/whitelist";
import { ZERO_ADDRESS } from "../../src/core/addresses";

const POOL = "0x1111111111111111111111111111111111111111";
const SET = "0x2222222222222222222222222222222222222222";
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);

interface Erc20Stub {
  symbol?: () => Promise<string>;
  decimals?: () => Promise<bigint | number>;
}

function setChain(opts: {
  poolList?: string[];
  settlementList?: string[];
  erc20?: Record<string, Erc20Stub>;
}) {
  contractHandler = (address: string) => {
    const addr = address.toLowerCase();
    if (addr === POOL.toLowerCase()) {
      return { getWhitelistedTokens: async () => opts.poolList ?? [] };
    }
    if (addr === SET.toLowerCase()) {
      return { getWhitelistedTokens: async () => opts.settlementList ?? [] };
    }
    const stub = opts.erc20?.[addr] ?? {};
    return {
      symbol:
        stub.symbol ??
        (async () => {
          throw new Error("symbol() revert");
        }),
      decimals:
        stub.decimals ??
        (async () => {
          throw new Error("decimals() revert");
        }),
    };
  };
}

const provider = {} as never;

beforeEach(() => {
  // Default: any unexpected Contract construction is a test bug.
  contractHandler = () => {
    throw new Error("unexpected ethers.Contract construction");
  };
});

describe("fetchWhitelistedTokens", () => {
  it("returns the pool∩settlement intersection with on-chain metadata", async () => {
    setChain({
      poolList: [A, B, C],
      settlementList: [C, B, D], // A excluded; D excluded
      erc20: {
        [B.toLowerCase()]: { symbol: async () => "USDC", decimals: async () => 6n },
        [C.toLowerCase()]: { symbol: async () => "WTON", decimals: async () => 27n },
      },
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET);

    // A and D dropped by intersection; no overlay → symbol order.
    expect(tokens.map((t) => t.address)).toEqual([B, C]);
    expect(tokens[0]).toEqual({ address: B, symbol: "USDC", decimals: 6, isNative: false });
    // 27-decimals WTON read exactly off-chain, not coerced to 18.
    expect(tokens[1]).toEqual({ address: C, symbol: "WTON", decimals: 27, isNative: false });
  });

  it("sorts deterministically by symbol regardless of the on-chain order (no overlay)", async () => {
    // EnumerableSet order is not stable; the chain hands back C before B.
    setChain({
      poolList: [C, B],
      settlementList: [B, C],
      erc20: {
        [B.toLowerCase()]: { symbol: async () => "USDC", decimals: async () => 6n },
        [C.toLowerCase()]: { symbol: async () => "WTON", decimals: async () => 27n },
      },
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET);
    // "USDC" < "WTON" → B before C even though the chain returned C first.
    expect(tokens.map((t) => t.symbol)).toEqual(["USDC", "WTON"]);
  });

  it("orders overlay tokens first in overlay order, on-chain-only extras after by symbol", async () => {
    // Chain returns three tokens in an arbitrary order; overlay lists
    // WTON(C) then USDC(B) and omits ZZZ(A) entirely.
    setChain({
      poolList: [A, B, C],
      settlementList: [A, B, C],
      erc20: {
        [A.toLowerCase()]: { symbol: async () => "ZZZ", decimals: async () => 18n },
        [B.toLowerCase()]: { symbol: async () => "USDC", decimals: async () => 6n },
        [C.toLowerCase()]: { symbol: async () => "WTON", decimals: async () => 18n },
      },
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET, {
      overlay: [
        { address: C, symbol: "WTON", decimals: 18, isNative: false },
        { address: B, symbol: "USDC", decimals: 6, isNative: false },
      ],
    });

    // Overlay order first (C, B), then the on-chain-only extra (A=ZZZ).
    expect(tokens.map((t) => t.symbol)).toEqual(["WTON", "USDC", "ZZZ"]);
  });

  it("lets the overlay override the on-chain symbol while decimals stay on-chain", async () => {
    setChain({
      poolList: [B],
      settlementList: [B],
      erc20: { [B.toLowerCase()]: { symbol: async () => "TestUSDC", decimals: async () => 6n } },
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET, {
      overlay: [{ address: B, symbol: "USDC", decimals: 99, isNative: false }],
    });

    expect(tokens[0].symbol).toBe("USDC"); // overlay label wins
    expect(tokens[0].decimals).toBe(6); // chain decimals win over overlay's 99
  });

  it("falls back to overlay symbol when symbol() reverts (decimals still on-chain)", async () => {
    setChain({
      poolList: [B],
      settlementList: [B],
      erc20: { [B.toLowerCase()]: { decimals: async () => 6n } }, // symbol() reverts
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET, {
      overlay: [{ address: B, symbol: "USDC", decimals: 18, isNative: false }],
    });

    expect(tokens[0].symbol).toBe("USDC");
    expect(tokens[0].decimals).toBe(6);
  });

  it("falls back to overlay decimals when decimals() reverts", async () => {
    setChain({
      poolList: [B],
      settlementList: [B],
      erc20: { [B.toLowerCase()]: { symbol: async () => "USDC" } }, // decimals() reverts
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET, {
      overlay: [{ address: B, symbol: "USDC", decimals: 6, isNative: false }],
    });

    expect(tokens[0].decimals).toBe(6);
  });

  it("drops a token whose symbol+decimals resolve from neither chain nor overlay", async () => {
    setChain({
      poolList: [B, C],
      settlementList: [B, C],
      erc20: {
        [B.toLowerCase()]: { symbol: async () => "USDC", decimals: async () => 6n },
        // C: both reads revert, no overlay → unusable, dropped
      },
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET);
    expect(tokens.map((t) => t.symbol)).toEqual(["USDC"]);
  });

  it("dedupes repeated addresses in the pool list", async () => {
    setChain({
      poolList: [B, B],
      settlementList: [B],
      erc20: { [B.toLowerCase()]: { symbol: async () => "USDC", decimals: async () => 6n } },
    });

    const tokens = await fetchWhitelistedTokens(provider, POOL, SET);
    expect(tokens.map((t) => t.address)).toEqual([B]);
  });

  it("returns [] for an empty intersection", async () => {
    setChain({ poolList: [A], settlementList: [D] });
    expect(await fetchWhitelistedTokens(provider, POOL, SET)).toEqual([]);
  });

  it("returns [] without touching the chain when an address is unconfigured", async () => {
    // contractHandler throws by default — reaching it would fail the test.
    expect(await fetchWhitelistedTokens(provider, ZERO_ADDRESS, SET)).toEqual([]);
    expect(await fetchWhitelistedTokens(provider, POOL, ZERO_ADDRESS)).toEqual([]);
  });

  it("throws when a whitelist getter reverts so callers can fall back", async () => {
    contractHandler = (address: string) => {
      if (address.toLowerCase() === POOL.toLowerCase()) {
        return {
          getWhitelistedTokens: async () => {
            throw new Error("no such function");
          },
        };
      }
      return { getWhitelistedTokens: async () => [] };
    };

    await expect(fetchWhitelistedTokens(provider, POOL, SET)).rejects.toThrow();
  });
});
