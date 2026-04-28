import { describe, it, expect } from "vitest";
import {
  TIER_16,
  TIER_64,
  TIER_128,
  TIERS,
  ACTIVE_TIERS,
  pickTier,
  padClaims,
  MAX_CLAIMS_PER_SIDE,
  CLAIMS_TREE_DEPTH,
} from "../../../packages/sdk/src/zk";

// Lightweight unit tests for the multi-tier circuit helpers added to
// the SDK. Lives in zk-relayer because the SDK has no test runner of
// its own — the imports go through `file:` link to the same source.
describe("CircuitTier registry", () => {
  it("exposes the three planned tiers in capacity order", () => {
    expect(TIERS).toEqual([TIER_16, TIER_64, TIER_128]);
    expect(TIER_16.cap).toBe(16);
    expect(TIER_64.cap).toBe(64);
    expect(TIER_128.cap).toBe(128);
  });

  it("matches log2(cap) on each tier's claims tree depth", () => {
    expect(1 << TIER_16.claimsTreeDepth).toBe(TIER_16.cap);
    expect(1 << TIER_64.claimsTreeDepth).toBe(TIER_64.cap);
    expect(1 << TIER_128.claimsTreeDepth).toBe(TIER_128.cap);
  });

  it("only marks tier 16 active until the 64/128 ceremonies ship", () => {
    expect(ACTIVE_TIERS).toEqual([TIER_16]);
  });

  it("keeps the legacy constants pointing at tier 16", () => {
    expect(MAX_CLAIMS_PER_SIDE).toBe(TIER_16.cap);
    expect(CLAIMS_TREE_DEPTH).toBe(TIER_16.claimsTreeDepth);
  });
});

describe("pickTier", () => {
  it.each([
    [1, TIER_16],
    [16, TIER_16],
    [17, TIER_64],
    [64, TIER_64],
    [65, TIER_128],
    [128, TIER_128],
  ])("recipientCount=%i -> cap=%i", (count, expected) => {
    expect(pickTier(count)).toBe(expected);
  });

  it("rejects 0 and negatives", () => {
    expect(() => pickTier(0)).toThrow(/positive integer/);
    expect(() => pickTier(-3)).toThrow(/positive integer/);
  });

  it("rejects fractional input", () => {
    expect(() => pickTier(1.5)).toThrow(/positive integer/);
  });

  it("rejects above-largest-tier counts with an actionable message", () => {
    expect(() => pickTier(129)).toThrow(/exceeds the largest tier/);
  });
});

describe("padClaims", () => {
  const dummy = { recipient: "0x0", amount: 0n } as const;

  it("fills up to tier capacity with the dummy entry", () => {
    const claims = [{ recipient: "0xA", amount: 1n }];
    const padded = padClaims(claims, TIER_16, dummy);
    expect(padded).toHaveLength(16);
    expect(padded[0]).toEqual({ recipient: "0xA", amount: 1n });
    expect(padded[15]).toEqual(dummy);
  });

  it("returns a fresh array — does not mutate input", () => {
    const claims = [{ recipient: "0xA", amount: 1n }];
    padClaims(claims, TIER_16, dummy);
    expect(claims).toHaveLength(1);
  });

  it("returns a length-cap array even when input is exactly cap", () => {
    const claims = Array.from({ length: 16 }, (_, i) => ({
      recipient: `0x${i}`,
      amount: BigInt(i),
    }));
    expect(padClaims(claims, TIER_16, dummy)).toHaveLength(16);
  });

  it("throws when the input exceeds tier capacity", () => {
    const claims = Array.from({ length: 17 }, () => dummy);
    expect(() => padClaims(claims, TIER_16, dummy)).toThrow(/exceeds tier 16 capacity/);
  });
});
