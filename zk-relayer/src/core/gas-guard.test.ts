import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing gas-guard
vi.mock("../config.js", () => ({
  config: { maxGasPriceGwei: 100 },
}));

import { estimateAndGuard } from "./gas-guard.js";

/** Helper: create a mock contract with configurable estimateGas */
function mockContract(
  estimatedGas: bigint,
  feeData: { gasPrice?: bigint | null; maxFeePerGas?: bigint | null } | null,
) {
  const provider = {
    getFeeData: vi.fn().mockResolvedValue(feeData),
  };
  const estimateGas = vi.fn().mockResolvedValue(estimatedGas);
  return {
    runner: { provider },
    settlePrivate: { estimateGas },
  } as any;
}

describe("estimateAndGuard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Test 1: Gas price cap rejection ───
  it("should reject when gasPrice exceeds MAX_GAS_PRICE_GWEI", async () => {
    // MAX_GAS_PRICE_GWEI = 100 → maxGasPriceWei = 100 gwei = 100_000_000_000
    const highGasPrice = 150_000_000_000n; // 150 gwei
    const contract = mockContract(100_000n, { gasPrice: highGasPrice });

    const result = await estimateAndGuard(contract, "settlePrivate", [], 1_000_000_000_000_000n);

    expect(result.profitable).toBe(false);
    expect(result.reason).toContain("exceeds max");
    expect(result.reason).toContain("100");
    expect(result.gasPrice).toBe(highGasPrice);
  });

  it("should pass when gasPrice is within MAX_GAS_PRICE_GWEI", async () => {
    const normalGasPrice = 50_000_000_000n; // 50 gwei
    const contract = mockContract(100_000n, { gasPrice: normalGasPrice });
    const highFee = 100_000_000_000_000_000n; // 0.1 ETH — well above gas cost

    const result = await estimateAndGuard(contract, "settlePrivate", [], highFee);

    expect(result.profitable).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // ─── Test 2: Profitability rejection ───
  it("should reject when gasCost exceeds feeValueNativeWei", async () => {
    const gasPrice = 50_000_000_000n; // 50 gwei
    const estimatedGas = 500_000n;
    // bufferedGas = ceil(500_000 * 12 / 10) = 600_000
    // gasCost = 600_000 * 50 gwei = 30_000_000_000_000_000 = 0.03 ETH
    const contract = mockContract(estimatedGas, { gasPrice });
    const tinyFee = 1_000_000_000_000n; // 0.000001 ETH — below gas cost

    const result = await estimateAndGuard(contract, "settlePrivate", [], tinyFee);

    expect(result.profitable).toBe(false);
    expect(result.reason).toContain("exceeds fee");
    expect(result.gasCostWei).toBeGreaterThan(tinyFee);
  });

  it("should approve when fee exceeds gasCost", async () => {
    const gasPrice = 10_000_000_000n; // 10 gwei
    const estimatedGas = 100_000n;
    const contract = mockContract(estimatedGas, { gasPrice });
    const largeFee = 10_000_000_000_000_000n; // 0.01 ETH

    const result = await estimateAndGuard(contract, "settlePrivate", [], largeFee);

    expect(result.profitable).toBe(true);
    expect(result.gasCostWei).toBeLessThan(largeFee);
  });

  // ─── Test 3: Skip profitability when fee is zero ───
  it("should skip profitability check when feeValueNativeWei = 0n or omitted", async () => {
    const gasPrice = 50_000_000_000n; // 50 gwei
    const contract = mockContract(500_000n, { gasPrice });

    const explicit = await estimateAndGuard(contract, "settlePrivate", [], 0n);
    expect(explicit.profitable).toBe(true);
    expect(explicit.reason).toBeUndefined();
    expect(explicit.gasCostWei).toBeGreaterThan(0n);

    const defaultArg = await estimateAndGuard(contract, "settlePrivate", []);
    expect(defaultArg.profitable).toBe(true);
  });

  // ─── Test 4: Missing provider fee data ───
  it("should throw when provider returns no gasPrice or maxFeePerGas", async () => {
    const contract = mockContract(100_000n, { gasPrice: null, maxFeePerGas: null });

    await expect(
      estimateAndGuard(contract, "settlePrivate", []),
    ).rejects.toThrow("Unable to determine gas price from provider fee data");
  });

  it("should throw when contract has no provider", async () => {
    const contract = { runner: {}, settlePrivate: { estimateGas: vi.fn() } } as any;

    await expect(
      estimateAndGuard(contract, "settlePrivate", []),
    ).rejects.toThrow("Contract has no provider");
  });

  it("should use maxFeePerGas when gasPrice is null", async () => {
    const maxFee = 30_000_000_000n; // 30 gwei
    const contract = mockContract(100_000n, { gasPrice: null, maxFeePerGas: maxFee });

    const result = await estimateAndGuard(contract, "settlePrivate", [], 0n);

    expect(result.gasPrice).toBe(maxFee);
    expect(result.profitable).toBe(true);
  });

  // ─── Test 5: BigInt precision ───
  it("should apply 1.2x buffer using pure bigint math (ceiling division)", async () => {
    const gasPrice = 1_000_000_000n; // 1 gwei
    const estimatedGas = 100_000n;
    const contract = mockContract(estimatedGas, { gasPrice });

    const result = await estimateAndGuard(contract, "settlePrivate", [], 0n);

    // bufferedGas = ceil(100_000 * 12 / 10) = 120_000
    expect(result.estimatedGas).toBe(120_000n);
  });

  it("should ceiling-round odd gas estimates correctly", async () => {
    const gasPrice = 1_000_000_000n;
    const estimatedGas = 100_001n; // not evenly divisible
    const contract = mockContract(estimatedGas, { gasPrice });

    const result = await estimateAndGuard(contract, "settlePrivate", [], 0n);

    // bufferedGas = ceil(100_001 * 12 / 10) = ceil(1_200_012 / 10) = 120_002
    const expected = (100_001n * 12n + 9n) / 10n;
    expect(result.estimatedGas).toBe(expected);
    expect(result.estimatedGas).toBe(120_002n);
  });

  it("should handle very large gas estimates without precision loss", async () => {
    const gasPrice = 1n;
    // Use a value larger than Number.MAX_SAFE_INTEGER
    const largeGas = BigInt("9007199254740993"); // 2^53 + 1
    const contract = mockContract(largeGas, { gasPrice });

    const result = await estimateAndGuard(contract, "settlePrivate", [], 0n);

    // Verify pure bigint math: no precision loss
    const expected = (largeGas * 12n + 9n) / 10n;
    expect(result.estimatedGas).toBe(expected);
    // If Number conversion was used, this would fail due to precision loss
    expect(result.estimatedGas).not.toBe(BigInt(Math.ceil(Number(largeGas) * 1.2)));
  });

  // ─── Edge case: gas cost calculation ───
  it("should calculate gasCostWei as bufferedGas * gasPrice", async () => {
    const gasPrice = 20_000_000_000n; // 20 gwei
    const estimatedGas = 200_000n;
    const contract = mockContract(estimatedGas, { gasPrice });

    const result = await estimateAndGuard(contract, "settlePrivate", [], 0n);

    // bufferedGas = 240_000, gasCost = 240_000 * 20 gwei = 4_800_000_000_000_000
    expect(result.estimatedGas).toBe(240_000n);
    expect(result.gasCostWei).toBe(240_000n * gasPrice);
    expect(result.gasCostEth).toBe("0.0048");
  });
});
