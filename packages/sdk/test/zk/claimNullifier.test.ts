import { describe, expect, it } from "vitest";
import { computeClaimNullifier } from "../../src/zk";

/** Regression for the cross-group claim-nullifier collision (HIGH). The claim
 *  nullifier now binds `claimsRoot`, so the SAME (secret, leafIndex) in two
 *  different settled claims groups produces DISTINCT nullifiers — a malicious
 *  maker can no longer brick an honest recipient's claim with a colliding leaf
 *  in a throwaway group. Must stay byte-identical to claim_template.circom's
 *  Poseidon(4)[TAG_CLAIM_NULL, secret, leafIndex, claimsRoot] derivation. */
describe("computeClaimNullifier — claimsRoot binding", () => {
  const secret = 0xABCDEFn;
  const leafIndex = 3n;

  it("is deterministic for the same (secret, leafIndex, claimsRoot)", async () => {
    const a = await computeClaimNullifier(secret, leafIndex, 0x1234n);
    const b = await computeClaimNullifier(secret, leafIndex, 0x1234n);
    expect(a).toBe(b);
  });

  it("differs across claims roots for the same (secret, leafIndex)", async () => {
    const inRootA = await computeClaimNullifier(secret, leafIndex, 0xAAAAn);
    const inRootB = await computeClaimNullifier(secret, leafIndex, 0xBBBBn);
    expect(inRootA).not.toBe(inRootB);
  });

  it("still differs across leaves within the same root", async () => {
    const leaf0 = await computeClaimNullifier(secret, 0n, 0xAAAAn);
    const leaf1 = await computeClaimNullifier(secret, 1n, 0xAAAAn);
    expect(leaf0).not.toBe(leaf1);
  });

  it("still differs across secrets", async () => {
    const s1 = await computeClaimNullifier(0x1n, leafIndex, 0xAAAAn);
    const s2 = await computeClaimNullifier(0x2n, leafIndex, 0xAAAAn);
    expect(s1).not.toBe(s2);
  });
});
