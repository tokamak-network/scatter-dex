import { describe, it, expect } from "vitest";
import {
  tierForOrder,
  validateAuthorizeOrder,
  type AuthorizeOrderFile,
} from "./authorize-order.js";

const RELAYER = "0x0123456789abcdef0123456789abcdef01234567";

function makeOrder(overrides: Partial<AuthorizeOrderFile> = {}): AuthorizeOrderFile {
  // Hand-built fixture — only the fields validateAuthorizeOrder reads
  // matter, so this stays cheap (no real proof / no field-element
  // randomness). The relayer in publicSignals matches RELAYER above
  // so the "bound to relayer" check passes.
  const ps = {
    pubKeyBind: "1",
    commitmentRoot: "1",
    nullifier: "1",
    nonceNullifier: "1",
    newCommitment: "1",
    sellToken: "1",
    buyToken: "2",
    sellAmount: "1000000000000000000",
    buyAmount: "1000000000000000000",
    maxFee: "100",
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
    claimsRoot: "1",
    totalLocked: "1000000000000000000",
    relayer: BigInt(RELAYER).toString(),
    orderHash: "1",
  };
  const baseArr = [
    ps.pubKeyBind, ps.commitmentRoot, ps.nullifier, ps.nonceNullifier,
    ps.newCommitment, ps.sellToken, ps.buyToken, ps.sellAmount, ps.buyAmount,
    ps.maxFee, ps.expiry, ps.claimsRoot, ps.totalLocked, ps.relayer, ps.orderHash,
  ];
  return {
    proof: { a: ["1", "2"], b: [["1", "2"], ["3", "4"]], c: ["1", "2"] },
    publicSignals: ps,
    publicSignalsArray: baseArr,
    ...overrides,
  };
}

describe("AuthorizeOrderFile.tier", () => {
  describe("tierForOrder", () => {
    it("returns the order's tier when set", () => {
      expect(tierForOrder(makeOrder({ tier: 16 }))).toBe(16);
      expect(tierForOrder(makeOrder({ tier: 64 }))).toBe(64);
      expect(tierForOrder(makeOrder({ tier: 128 }))).toBe(128);
    });

    it("falls back to tier 16 for legacy clients (transitional)", () => {
      // Migration path: old clients that haven't upgraded keep working.
      // When tier 64/128 actually ship, this fallback should be removed
      // and missing-tier requests should hard-reject.
      expect(tierForOrder(makeOrder({}))).toBe(16);
    });
  });

  describe("validateAuthorizeOrder tier rules", () => {
    const now = Math.floor(Date.now() / 1000);

    it("accepts an order without tier (legacy back-compat)", () => {
      expect(validateAuthorizeOrder(makeOrder(), RELAYER, now)).toBeNull();
    });

    it("accepts each known tier", () => {
      expect(validateAuthorizeOrder(makeOrder({ tier: 16 }), RELAYER, now)).toBeNull();
      expect(validateAuthorizeOrder(makeOrder({ tier: 64 }), RELAYER, now)).toBeNull();
      expect(validateAuthorizeOrder(makeOrder({ tier: 128 }), RELAYER, now)).toBeNull();
    });

    it("rejects an out-of-set tier value", () => {
      // Cast bypasses the literal-union compile-time check so we can
      // exercise the runtime validator path that would reject malformed
      // payloads from older or buggy clients.
      const bad = makeOrder({ tier: 32 as unknown as 16 });
      expect(validateAuthorizeOrder(bad, RELAYER, now)).toMatch(/tier must be one of/);
    });
  });
});
