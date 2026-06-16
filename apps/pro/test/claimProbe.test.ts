// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { computeClaimNullifier, toBytes32Hex } from "@zkscatter/sdk/zk";
import { isClaimNullifierSpentOn, settlementReader } from "../app/lib/claimProbe";

/** A minimal stand-in for the PrivateSettlement contract — only the
 *  read method the probe touches. Cast through `unknown` so we don't
 *  drag in the full ethers.Contract surface. */
function fakeSettlement(spent: boolean) {
  const claimNullifiers = vi.fn(async () => spent);
  return {
    contract: { claimNullifiers } as unknown as ethers.Contract,
    claimNullifiers,
  };
}

describe("isClaimNullifierSpentOn", () => {
  it("reads claimNullifiers with the bytes32 of this leaf's nullifier", async () => {
    const secret = 0x1234_5678n;
    const leafIndex = 2;
    const expectedKey = toBytes32Hex(
      await computeClaimNullifier(secret, BigInt(leafIndex)),
    );
    const { contract, claimNullifiers } = fakeSettlement(true);

    const spent = await isClaimNullifierSpentOn(contract, secret, leafIndex);

    expect(spent).toBe(true);
    expect(claimNullifiers).toHaveBeenCalledWith(expectedKey);
  });

  it("returns false when the nullifier is unspent (passes the chain's answer through)", async () => {
    const { contract } = fakeSettlement(false);
    expect(await isClaimNullifierSpentOn(contract, 7n, 0)).toBe(false);
  });

  // Guards the inversion bug class: leaf #0 and leaf #1 of the same
  // order share a secret but MUST hash to different nullifiers, or the
  // drawer could attribute one recipient's claim to the other.
  it("derives a distinct nullifier per leafIndex (no cross-leaf collision)", async () => {
    const keys: string[] = [];
    const contract = {
      claimNullifiers: vi.fn(async (h: string) => {
        keys.push(h);
        return false;
      }),
    } as unknown as ethers.Contract;

    await isClaimNullifierSpentOn(contract, 99n, 0);
    await isClaimNullifierSpentOn(contract, 99n, 1);

    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("settlementReader", () => {
  it("binds the contract to the given settlement address", () => {
    const provider = new ethers.JsonRpcProvider();
    const addr = "0x00000000000000000000000000000000000000ab";
    const reader = settlementReader(provider, addr);
    expect(String(reader.target).toLowerCase()).toBe(addr);
  });
});
