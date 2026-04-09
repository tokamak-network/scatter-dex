import { describe, it, expect } from "vitest";
import { parsePrivateOrder, pairKey } from "../src/types/order.js";

function makeRawOrder(overrides: Record<string, unknown> = {}) {
  return {
    sellToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    buyToken: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    sellAmount: "10000000000000000000",
    buyAmount: "21000000000000000000000",
    maxFee: "60",
    expiry: String(Math.floor(Date.now() / 1000) + 86400),
    nonce: "1",
    pubKeyAx: "1000",
    pubKeyAy: "2000",
    sigS: "3000",
    sigR8x: "4000",
    sigR8y: "5000",
    ownerSecret: "100",
    balance: "100000000000000000000",
    salt: "200",
    leafIndex: 0,
    newSalt: "300",
    expectedChangeCommitment: "400",
    claims: [{
      secret: "9000",
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      token: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      amount: "21000000000000000000000",
      releaseTime: String(Math.floor(Date.now() / 1000) + 3600),
    }],
    ...overrides,
  };
}

describe("parsePrivateOrder", () => {
  it("parses valid order", () => {
    const order = parsePrivateOrder(makeRawOrder());
    expect(order.sellAmount).toBe(10n * 10n ** 18n);
    expect(order.buyAmount).toBe(21000n * 10n ** 18n);
    expect(order.claims).toHaveLength(1);
  });

  it("rejects missing sellToken", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ sellToken: undefined }))).toThrow("sellToken");
  });

  it("rejects non-numeric sellAmount", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ sellAmount: "abc" }))).toThrow("not a valid number");
  });

  it("rejects zero sellAmount", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ sellAmount: "0" }))).toThrow("sellAmount must be > 0");
  });

  it("rejects negative maxFee", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ maxFee: "-1" }))).toThrow("maxFee must be >= 0");
  });

  it("rejects negative leafIndex", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ leafIndex: -1 }))).toThrow("leafIndex must be");
  });

  it("[PR #125 review] rejects leafIndex above tree depth (>= 2^20)", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ leafIndex: 1 << 20 })))
      .toThrow("leafIndex must be");
  });

  it("rejects empty claims", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ claims: [] }))).toThrow("claims must be 1-16");
  });

  it("rejects too many claims", () => {
    const claims = Array.from({ length: 17 }, () => ({
      secret: "9000", recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      token: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      amount: "1000", releaseTime: "9999999999",
    }));
    expect(() => parsePrivateOrder(makeRawOrder({ claims }))).toThrow("claims must be 1-16");
  });

  it("validates sellToken as 160-bit address", () => {
    const tooBig = "0x" + "F".repeat(42); // > 2^160
    expect(() => parsePrivateOrder(makeRawOrder({ sellToken: tooBig }))).toThrow("160-bit address");
  });

  it("validates claim recipient as 160-bit address", () => {
    const tooBig = (1n << 161n).toString();
    const claims = [{
      secret: "9000", recipient: tooBig,
      token: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      amount: "1000", releaseTime: "9999999999",
    }];
    expect(() => parsePrivateOrder(makeRawOrder({ claims }))).toThrow("160-bit address");
  });

  // ─── [M8] Field-range validation ────────────────────────────
  const BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const TWO_126 = 1n << 126n;
  const TWO_128 = 1n << 128n;

  it("[PR #125 review] rejects sellAmount above 126 bits (matches Num2Bits(126))", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ sellAmount: TWO_126.toString() })))
      .toThrow("126-bit range");
  });

  it("[PR #125 review] rejects buyAmount above 126 bits", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ buyAmount: TWO_126.toString() })))
      .toThrow("126-bit range");
  });

  it("[M8] rejects balance above 128 bits", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ balance: TWO_128.toString() })))
      .toThrow("128-bit range");
  });

  it("[M8] rejects maxFee above 16 bits", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ maxFee: "65536" })))
      .toThrow("16-bit range");
  });

  it("[M8] rejects ownerSecret >= BN254 modulus", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ ownerSecret: BN254.toString() })))
      .toThrow("BN254 scalar field modulus");
  });

  it("[M8] rejects pubKeyAx >= BN254 modulus", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ pubKeyAx: BN254.toString() })))
      .toThrow("BN254 scalar field modulus");
  });

  it("[M8] rejects sigS >= BN254 modulus", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ sigS: BN254.toString() })))
      .toThrow("BN254 scalar field modulus");
  });

  it("[M8] rejects negative salt", () => {
    expect(() => parsePrivateOrder(makeRawOrder({ salt: "-1" })))
      .toThrow("non-negative");
  });

  it("[M8] rejects claim secret >= BN254 modulus", () => {
    const claims = [{
      secret: BN254.toString(),
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      token: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      amount: "1000", releaseTime: "9999999999",
    }];
    expect(() => parsePrivateOrder(makeRawOrder({ claims })))
      .toThrow("BN254 scalar field modulus");
  });

  it("[PR #125 review] rejects claim amount above 126 bits", () => {
    const claims = [{
      secret: "9000",
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      token: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      amount: TWO_126.toString(),
      releaseTime: "9999999999",
    }];
    expect(() => parsePrivateOrder(makeRawOrder({ claims })))
      .toThrow("126-bit range");
  });
});

describe("pairKey", () => {
  it("produces sorted pair key", () => {
    const a = BigInt("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const b = BigInt("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(pairKey(a, b)).toBe(pairKey(b, a));
  });

  it("lowercase hex addresses", () => {
    const a = BigInt("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const b = BigInt("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    const key = pairKey(a, b);
    expect(key).toMatch(/^0x[0-9a-f]+-0x[0-9a-f]+$/);
  });
});
