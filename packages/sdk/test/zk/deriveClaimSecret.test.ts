import { describe, expect, it } from "vitest";
import {
  buildClaimsTree,
  deriveClaimSecret,
  splitPayout,
  withDeterministicSecrets,
  type PayoutRecipient,
} from "../../src/zk";

const TOKEN = "0xa30fe40285B8f5c0457DbC3B7C8A280373c40044";
const SEED = 1234567890123456789012345678901234567890n;
const recips = (): PayoutRecipient[] => [
  { recipient: "0xc1eba383d94c6021160042491a5dfaf1d82694e6", amount: 100n, releaseTime: 1781076887n },
  { recipient: "0x796C1f28c777b8a5851D356EBbc9DeC2ee51137F", amount: 200n, releaseTime: 1781076887n },
];

describe("deriveClaimSecret", () => {
  it("is deterministic for identical inputs", async () => {
    const a = await deriveClaimSecret(SEED, recips()[0]!.recipient, TOKEN, 100n, 1781076887n, 0);
    const b = await deriveClaimSecret(SEED, recips()[0]!.recipient, TOKEN, 100n, 1781076887n, 0);
    expect(a).toBe(b);
  });

  it("differs by index, seed, and recipient", async () => {
    const base = await deriveClaimSecret(SEED, recips()[0]!.recipient, TOKEN, 100n, 1781076887n, 0);
    const byIndex = await deriveClaimSecret(SEED, recips()[0]!.recipient, TOKEN, 100n, 1781076887n, 1);
    const bySeed = await deriveClaimSecret(SEED + 1n, recips()[0]!.recipient, TOKEN, 100n, 1781076887n, 0);
    const byRecip = await deriveClaimSecret(SEED, recips()[1]!.recipient, TOKEN, 100n, 1781076887n, 0);
    expect(new Set([base, byIndex, bySeed, byRecip]).size).toBe(4);
  });
});

describe("withDeterministicSecrets", () => {
  it("fills the same secrets across calls (reproducible)", async () => {
    const a = await withDeterministicSecrets(recips(), SEED, TOKEN);
    const b = await withDeterministicSecrets(recips(), SEED, TOKEN);
    expect(a.map((r) => r.secret)).toEqual(b.map((r) => r.secret));
    expect(a.every((r) => r.secret !== undefined)).toBe(true);
  });

  it("leaves a recipient's pre-set secret untouched", async () => {
    const withSecret: PayoutRecipient[] = [{ ...recips()[0]!, secret: 42n }];
    const out = await withDeterministicSecrets(withSecret, SEED, TOKEN);
    expect(out[0]!.secret).toBe(42n);
  });
});

describe("claimsRoot reproducibility (the fix)", () => {
  it("seeded secrets reproduce the SAME claimsRoot across retries", async () => {
    const root = async () => {
      const batches = splitPayout(await withDeterministicSecrets(recips(), SEED, TOKEN), {
        token: TOKEN,
      });
      const { root } = await buildClaimsTree(batches[0]!.claims, batches[0]!.tier);
      return root;
    };
    expect(await root()).toBe(await root());
  });

  it("default random secrets produce DIFFERENT roots each call (the hazard this replaces)", async () => {
    const root = async () => {
      const batches = splitPayout(recips(), { token: TOKEN });
      const { root } = await buildClaimsTree(batches[0]!.claims, batches[0]!.tier);
      return root;
    };
    expect(await root()).not.toBe(await root());
  });
});
