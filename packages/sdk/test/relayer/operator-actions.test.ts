import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ethers.Contract so loadExitCooldownSeconds runs against an
// in-memory `exitCooldown()` return. Interface/everything else stays real.
let cooldownReturn: bigint = 0n;

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class MockContract {
    async exitCooldown() {
      return cooldownReturn;
    }
  }
  return { ...actual, ethers: { ...actual.ethers, Contract: MockContract } };
});

import { loadExitCooldownSeconds } from "../../src/relayer/operator-actions";

const REGISTRY = "0x" + "1".repeat(40);
const provider = {} as never;

beforeEach(() => {
  cooldownReturn = 0n;
});

describe("loadExitCooldownSeconds", () => {
  it("reads the live cool-down and returns it as a number", async () => {
    cooldownReturn = 86_400n; // 1 day — the governance-shortened value
    expect(await loadExitCooldownSeconds(REGISTRY, provider)).toBe(86_400);
  });

  it("returns the 7-day default unchanged when that is the on-chain value", async () => {
    cooldownReturn = BigInt(7 * 24 * 60 * 60);
    expect(await loadExitCooldownSeconds(REGISTRY, provider)).toBe(604_800);
  });

  it("returns 0 for an immediate-withdraw cool-down", async () => {
    cooldownReturn = 0n;
    expect(await loadExitCooldownSeconds(REGISTRY, provider)).toBe(0);
  });
});
