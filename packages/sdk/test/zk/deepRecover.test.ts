import { describe, expect, it } from "vitest";
import {
  buildClaimsTree,
  deepRecoverReleaseTime,
  splitPayout,
  toBytes32Hex,
  withDeterministicSecrets,
} from "../../src/zk";

const TOKEN = "0xa30fe40285B8f5c0457DbC3B7C8A280373c40044";
const SEED = 4242n;
const RECIPS = [
  { recipient: "0xc1eba383d94c6021160042491a5dfaf1d82694e6", amount: 100n },
  { recipient: "0x796C1f28c777b8a5851D356EBbc9DeC2ee51137F", amount: 200n },
];
const TRUE_RELEASE = 1781076887;

// Build the on-chain root the operator would be matching against, using
// the same seed + the (unknown-to-the-search) true releaseTime.
async function targetRoot(): Promise<string> {
  const recips = RECIPS.map((r) => ({ ...r, releaseTime: BigInt(TRUE_RELEASE) }));
  const batch = splitPayout(await withDeterministicSecrets(recips, SEED, TOKEN), { token: TOKEN })[0]!;
  const { root } = await buildClaimsTree(batch.claims, batch.tier);
  return toBytes32Hex(root);
}

describe("deepRecoverReleaseTime", () => {
  it("finds the releaseTime that reproduces the on-chain root", async () => {
    const target = await targetRoot();
    const res = await deepRecoverReleaseTime({
      seed: SEED,
      recipients: RECIPS,
      token: TOKEN,
      tierCap: 16,
      targetClaimsRoot: target,
      startSec: TRUE_RELEASE - 3,
      endSec: TRUE_RELEASE + 3,
    });
    expect(res).not.toBeNull();
    expect(res!.releaseTime).toBe(BigInt(TRUE_RELEASE));
    // The recovered claims rebuild the exact target root.
    const rebuilt = await buildClaimsTree(res!.claims);
    expect(toBytes32Hex(rebuilt.root)).toBe(target.toLowerCase());
  });

  it("returns null when the window misses the true releaseTime", async () => {
    const target = await targetRoot();
    const res = await deepRecoverReleaseTime({
      seed: SEED,
      recipients: RECIPS,
      token: TOKEN,
      tierCap: 16,
      targetClaimsRoot: target,
      startSec: TRUE_RELEASE + 10,
      endSec: TRUE_RELEASE + 13,
    });
    expect(res).toBeNull();
  });

  it("throws when the candidate count exceeds the safety cap", async () => {
    await expect(
      deepRecoverReleaseTime({
        seed: SEED,
        recipients: RECIPS,
        token: TOKEN,
        tierCap: 16,
        targetClaimsRoot: "0x" + "0".repeat(64),
        startSec: 0,
        endSec: 1_000,
        maxCandidates: 10,
      }),
    ).rejects.toThrow(/exceed/i);
  });

  it("honors an abort signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      deepRecoverReleaseTime({
        seed: SEED,
        recipients: RECIPS,
        token: TOKEN,
        tierCap: 16,
        targetClaimsRoot: "0x" + "0".repeat(64),
        startSec: 0,
        endSec: 5,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });
});
