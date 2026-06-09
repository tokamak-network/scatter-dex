import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import { buildWriteOverrides } from "../../src/core/write";

const ABI = ["function foo(uint256 x) external"];
const SIGNER_ADDR = "0x" + "22".repeat(20);
const CONTRACT_ADDR = "0x" + "33".repeat(20);

function makeContract() {
  // The runner only needs to look like a Signer to buildWriteOverrides:
  // an address + (here) no provider, so the explicit estimateProvider wins.
  const signer = { getAddress: async () => SIGNER_ADDR, provider: null };
  return new ethers.Contract(CONTRACT_ADDR, ABI, signer as unknown as ethers.ContractRunner);
}

describe("buildWriteOverrides", () => {
  it("precomputes gas (with 20% buffer), EIP-1559 fees, and nonce on the estimate provider", async () => {
    const est = {
      estimateGas: vi.fn(async () => 100_000n),
      getFeeData: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 2n, gasPrice: 7n })),
      getTransactionCount: vi.fn(async () => 5),
    };
    const ov = await buildWriteOverrides(makeContract(), "foo", [123n], {
      estimateProvider: est as unknown as ethers.Provider,
    });

    expect(ov.gasLimit).toBe(120_000n); // 100k * 1.2
    expect(ov.maxFeePerGas).toBe(10n);
    expect(ov.maxPriorityFeePerGas).toBe(2n);
    expect(ov.gasPrice).toBeUndefined(); // EIP-1559 path wins
    expect(ov.nonce).toBe(5);
    // Preflight runs on the estimate provider, exactly once each.
    expect(est.estimateGas).toHaveBeenCalledOnce();
    expect(est.getTransactionCount).toHaveBeenCalledWith(SIGNER_ADDR, "pending");
  });

  it("rethrows a genuine revert so the caller sees the real reason", async () => {
    const revert = Object.assign(new Error("execution reverted: not owner"), {
      code: "CALL_EXCEPTION",
    });
    const est = {
      estimateGas: vi.fn(async () => {
        throw revert;
      }),
      getFeeData: vi.fn(async () => ({})),
      getTransactionCount: vi.fn(async () => 0),
    };
    await expect(
      buildWriteOverrides(makeContract(), "foo", [1n], {
        estimateProvider: est as unknown as ethers.Provider,
      }),
    ).rejects.toThrow(/not owner/);
  });

  it("rethrows deterministic/unknown estimate failures (revert, insufficient funds, bad gas) instead of degrading", async () => {
    for (const err of [
      Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" }),
      Object.assign(new Error("execution reverted"), { code: -32000 }),
      Object.assign(new Error("insufficient funds for intrinsic transaction cost"), {}),
      Object.assign(new Error("cannot estimate gas"), { code: "UNPREDICTABLE_GAS_LIMIT" }),
    ]) {
      const est = {
        estimateGas: vi.fn(async () => {
          throw err;
        }),
        getFeeData: vi.fn(async () => ({})),
        getTransactionCount: vi.fn(async () => 0),
      };
      await expect(
        buildWriteOverrides(makeContract(), "foo", [1n], {
          estimateProvider: est as unknown as ethers.Provider,
        }),
      ).rejects.toBe(err);
    }
  });

  it("degrades to the fallback gas on a transient (non-revert) estimate failure", async () => {
    const throttled = Object.assign(new Error("too many requests"), { code: "SERVER_ERROR" });
    const est = {
      estimateGas: vi.fn(async () => {
        throw throttled;
      }),
      getFeeData: vi.fn(async () => ({ gasPrice: 7n })), // legacy fee path
      getTransactionCount: vi.fn(async () => 3),
    };
    const ov = await buildWriteOverrides(makeContract(), "foo", [1n], {
      estimateProvider: est as unknown as ethers.Provider,
      fallbackGasLimit: 500_000n,
    });

    expect(ov.gasLimit).toBe(500_000n);
    expect(ov.gasPrice).toBe(7n); // legacy fee fallback
    expect(ov.maxFeePerGas).toBeUndefined();
    expect(ov.nonce).toBe(3);
  });
});
