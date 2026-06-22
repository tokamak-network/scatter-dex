import { describe, it, expect } from "vitest";
import {
  explainRegistryError,
  hasEnoughBondBalance,
  needsBondApproval,
  registerRelayer,
  NATIVE_BOND_TOKEN,
  MAX_RELAYER_FEE_BPS,
  type RegistrationStatus,
} from "../../src/relayer/register";

/** Build a RegistrationStatus with sane defaults; override per test. The
 *  helpers under test only read a handful of fields, so the rest are
 *  filler. */
function status(over: Partial<RegistrationStatus> = {}): RegistrationStatus {
  return {
    isVerified: true,
    verifiedUntil: 0,
    alreadyRegistered: false,
    minBond: 0n,
    minBondEth: "0",
    bondToken: NATIVE_BOND_TOKEN,
    isErc20Bond: false,
    bondTokenSymbol: "ETH",
    bondTokenDecimals: 18,
    bondAllowance: 0n,
    bondBalance: 0n,
    bondBalanceFormatted: "0",
    ...over,
  };
}

describe("hasEnoughBondBalance", () => {
  it("is true when the balance covers the bond (18 decimals)", () => {
    const s = status({ bondBalance: 1000n * 10n ** 18n, bondTokenDecimals: 18 });
    expect(hasEnoughBondBalance(s, "1000")).toBe(true);
    expect(hasEnoughBondBalance(s, "1000.0")).toBe(true);
  });

  it("is false when the balance is short", () => {
    const s = status({ bondBalance: 999n * 10n ** 18n });
    expect(hasEnoughBondBalance(s, "1000")).toBe(false);
  });

  it("respects the bond token's own decimals (6-decimal token)", () => {
    // 1000 units at 6 decimals = 1_000_000_000. A naive 18-decimal parse
    // would demand 1e21 and wrongly report "not enough".
    const s = status({ bondBalance: 1000n * 10n ** 6n, bondTokenDecimals: 6 });
    expect(hasEnoughBondBalance(s, "1000")).toBe(true);
  });

  it("returns true on an unparseable amount so a transient input never blocks", () => {
    const s = status({ bondBalance: 0n });
    expect(hasEnoughBondBalance(s, "not-a-number")).toBe(true);
  });
});

describe("needsBondApproval", () => {
  it("is false in native mode regardless of amount", () => {
    expect(needsBondApproval(status({ isErc20Bond: false }), "1000")).toBe(false);
  });

  it("is true when the ERC20 allowance is below the bond", () => {
    const s = status({ isErc20Bond: true, bondAllowance: 500n * 10n ** 18n });
    expect(needsBondApproval(s, "1000")).toBe(true);
  });

  it("is false when the allowance already covers the bond", () => {
    const s = status({ isErc20Bond: true, bondAllowance: 1000n * 10n ** 18n });
    expect(needsBondApproval(s, "1000")).toBe(false);
  });

  it("respects non-18 decimals", () => {
    const s = status({ isErc20Bond: true, bondTokenDecimals: 6, bondAllowance: 1000n * 10n ** 6n });
    expect(needsBondApproval(s, "1000")).toBe(false);
    expect(needsBondApproval(s, "1001")).toBe(true);
  });
});

describe("explainRegistryError InsufficientBond copy", () => {
  it("renders the minimum in the bond token symbol + decimals", () => {
    const err = new Error("execution reverted: InsufficientBond");
    const msg = explainRegistryError(err, 1000n * 10n ** 18n, { symbol: "TON", decimals: 18 });
    expect(msg).toBe("Insufficient bond. Minimum: 1000 TON");
  });

  it("defaults to ETH / 18 decimals when no bond meta is given", () => {
    const err = new Error("InsufficientBond");
    expect(explainRegistryError(err, 5n * 10n ** 17n)).toBe("Insufficient bond. Minimum: 0.5 ETH");
  });

  it("falls back to the raw message for unknown errors", () => {
    expect(explainRegistryError(new Error("boom"), 0n)).toContain("boom");
  });
});

describe("registerRelayer input validation", () => {
  const dummySigner = {} as never; // validation throws before the signer is touched

  it("rejects a non-integer / negative fee", async () => {
    await expect(
      registerRelayer("0xreg", { url: "u", feeBps: -1, bondEth: "0" }, dummySigner),
    ).rejects.toThrow("InvalidFee");
  });

  it("rejects a fee above the max", async () => {
    await expect(
      registerRelayer("0xreg", { url: "u", feeBps: MAX_RELAYER_FEE_BPS + 1, bondEth: "0" }, dummySigner),
    ).rejects.toThrow("FeeTooHigh");
  });

  it("rejects an unparseable bond amount", async () => {
    await expect(
      registerRelayer("0xreg", { url: "u", feeBps: 30, bondEth: "abc" }, dummySigner),
    ).rejects.toThrow("InvalidBond");
  });
});
