import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { claimSeedFromKey, FIELD_MODULUS } from "../../src/zk";

const key = (hex: string) => ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(hex)));

describe("claimSeedFromKey", () => {
  it("is deterministic for the same key bytes", () => {
    const k = key("wallet-a");
    expect(claimSeedFromKey(k)).toBe(claimSeedFromKey(key("wallet-a")));
  });

  it("differs for different keys", () => {
    expect(claimSeedFromKey(key("wallet-a"))).not.toBe(claimSeedFromKey(key("wallet-b")));
  });

  it("returns a value inside the BN254 scalar field", () => {
    const s = claimSeedFromKey(key("wallet-a"));
    expect(s).toBeGreaterThanOrEqual(0n);
    expect(s).toBeLessThan(FIELD_MODULUS);
  });
});
