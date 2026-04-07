import { describe, it, expect } from "vitest";

/**
 * Unit tests for private settlement fee calculation logic.
 * Validates the fee formula: feeToken = floor(sellAmount * feeBps / 10000)
 * Must match the ZK circuit's floor-division check:
 *   fee * 10000 <= sellAmount * feeBps < fee * 10000 + 10000
 */

const BPS_DENOMINATOR = 10000n;

function computeFee(sellAmount: bigint, feeBps: bigint): bigint {
  return (sellAmount * feeBps) / BPS_DENOMINATOR;
}

describe("private settlement fee calculation", () => {
  it("zero fee (maxFee = 0)", () => {
    const fee = computeFee(100n * 10n ** 18n, 0n);
    expect(fee).toBe(0n);
  });

  it("normal fee (0.3% = 30 bps)", () => {
    const sellAmount = 1000n * 10n ** 18n; // 1000 tokens
    const fee = computeFee(sellAmount, 30n);
    // 1000 * 30 / 10000 = 3 tokens
    expect(fee).toBe(3n * 10n ** 18n);
  });

  it("max boundary (100% = 10000 bps)", () => {
    const sellAmount = 500n * 10n ** 18n;
    const fee = computeFee(sellAmount, 10000n);
    expect(fee).toBe(sellAmount);
  });

  it("floor division — truncates remainder", () => {
    // 7 * 30 / 10000 = 0.021 → floor = 0
    expect(computeFee(7n, 30n)).toBe(0n);
    // 333 * 100 / 10000 = 3.33 → floor = 3
    expect(computeFee(333n, 100n)).toBe(3n);
    // 10001 * 1 / 10000 = 1.0001 → floor = 1
    expect(computeFee(10001n, 1n)).toBe(1n);
  });

  it("matches circuit floor-division constraint", () => {
    // Circuit checks: fee * 10000 <= sellAmount * feeBps < fee * 10000 + 10000
    const cases = [
      { sellAmount: 1000n * 10n ** 18n, feeBps: 30n },
      { sellAmount: 333n * 10n ** 6n, feeBps: 100n },
      { sellAmount: 7n * 10n ** 18n, feeBps: 1n },
      { sellAmount: 999999999999999999n, feeBps: 9999n },
    ];
    for (const { sellAmount, feeBps } of cases) {
      const fee = computeFee(sellAmount, feeBps);
      const product = sellAmount * feeBps;
      const feeScaled = fee * BPS_DENOMINATOR;
      // Lower bound: fee * 10000 <= product
      expect(feeScaled <= product).toBe(true);
      // Upper bound: product < fee * 10000 + 10000
      expect(product < feeScaled + BPS_DENOMINATOR).toBe(true);
    }
  });

  it("cross-side fee: maker fee deducted from maker's sell amount", () => {
    const makerSellAmount = 100n * 10n ** 18n;
    const takerSellAmount = 50n * 10n ** 18n;
    const makerFeeBps = 30n;  // 0.3%
    const takerFeeBps = 50n;  // 0.5%

    // feeTokenMaker = from taker's sell (what maker receives)
    const feeTokenMaker = computeFee(takerSellAmount, takerFeeBps);
    // feeTokenTaker = from maker's sell (what taker receives)
    const feeTokenTaker = computeFee(makerSellAmount, makerFeeBps);

    expect(feeTokenMaker).toBe(25n * 10n ** 16n); // 50 * 0.5% = 0.25
    expect(feeTokenTaker).toBe(30n * 10n ** 16n); // 100 * 0.3% = 0.3
  });

  it("mismatched maker/taker fee rates", () => {
    const sellAmount = 1000n * 10n ** 18n;
    const makerFee = computeFee(sellAmount, 10n);   // 0.1%
    const takerFee = computeFee(sellAmount, 100n);  // 1.0%

    expect(makerFee).toBe(1n * 10n ** 18n);   // 1 token
    expect(takerFee).toBe(10n * 10n ** 18n);  // 10 tokens
    expect(takerFee).toBe(makerFee * 10n);
  });
});

describe("relayer minimum fee rejection", () => {
  const RELAYER_MIN_FEE = 30n; // config.relayerFee default

  function validateFeeBps(makerFeeBps: bigint, takerFeeBps: bigint, minFeeBps: bigint): string | null {
    if (makerFeeBps < minFeeBps || takerFeeBps < minFeeBps) {
      return `Fee too low: maker=${makerFeeBps} bps, taker=${takerFeeBps} bps, minimum=${minFeeBps} bps. Rejecting settlement.`;
    }
    return null;
  }

  it("accepts fees at or above minimum", () => {
    expect(validateFeeBps(30n, 30n, RELAYER_MIN_FEE)).toBeNull();
    expect(validateFeeBps(100n, 50n, RELAYER_MIN_FEE)).toBeNull();
  });

  it("rejects when maker fee is below minimum", () => {
    const err = validateFeeBps(10n, 30n, RELAYER_MIN_FEE);
    expect(err).toContain("Fee too low");
    expect(err).toContain("maker=10");
  });

  it("rejects when taker fee is below minimum", () => {
    const err = validateFeeBps(30n, 5n, RELAYER_MIN_FEE);
    expect(err).toContain("Fee too low");
    expect(err).toContain("taker=5");
  });

  it("rejects when both fees are below minimum", () => {
    const err = validateFeeBps(0n, 0n, RELAYER_MIN_FEE);
    expect(err).toContain("Fee too low");
  });

  it("accepts zero-fee when relayer min is 0", () => {
    expect(validateFeeBps(0n, 0n, 0n)).toBeNull();
  });
});
