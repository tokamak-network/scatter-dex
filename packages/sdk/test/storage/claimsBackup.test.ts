import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory folder so save/load/list exercise the real keying + validation
// without the File System Access API. `vi.hoisted` lets the mock factory
// (hoisted above imports) share this store with the test body.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../src/storage/folder", () => ({
  hasFolder: () => true,
  saveFile: async (name: string, content: string) => {
    store.set(name, content);
  },
  loadFile: async (name: string) => store.get(name) ?? null,
  listFiles: async (match?: (n: string) => boolean) =>
    [...store.keys()]
      .filter((n) => !match || match(n))
      .map((name) => ({ filename: name, read: async () => store.get(name)! })),
}));

import {
  saveClaimsBackup,
  loadClaimsBackup,
  listClaimsBackups,
  type ClaimsBackup,
} from "../../src/storage/claimsBackup";
import {
  buildClaimsTree,
  splitPayout,
  toBytes32Hex,
  withDeterministicSecrets,
  TIER_16,
} from "../../src/zk";

const TOKEN = "0xa30fe40285B8f5c0457DbC3B7C8A280373c40044";
const ROOT_A = "0x0884bb29acb1d3259413175cf0d5357bcc06e620ad4a6e3a0481c78ec409e984";
const ROOT_B = "0x191e8b02a1d2c6c0ae01b8ef85f6a4303ab902f31857fcbb6dbe65b82c4951cb";

const backup = (claimsRoot: string): ClaimsBackup => ({
  version: 1,
  createdAt: 1781076754,
  chainId: 11155111,
  settlementAddress: "0x9546B0A1f9cf52405645f3EFD86E06f7ea76Ef74",
  claimsRoot,
  tierCap: 16,
  token: TOKEN,
  tokenSymbol: "TON",
  tokenDecimals: 18,
  payoutSeed: "123",
  claims: [{ recipient: "0xc1eba383d94c6021160042491a5dfaf1d82694e6", amount: "100", releaseTime: "1781076887", secret: "7" }],
});

beforeEach(() => store.clear());

describe("claimsBackup save/load/list", () => {
  it("round-trips a backup keyed by claimsRoot", async () => {
    await saveClaimsBackup(backup(ROOT_A));
    expect(await loadClaimsBackup(ROOT_A)).toMatchObject({ claimsRoot: ROOT_A, tierCap: 16 });
  });

  it("keys by root so distinct attempts never overwrite each other", async () => {
    await saveClaimsBackup(backup(ROOT_A));
    await saveClaimsBackup(backup(ROOT_B));
    expect(await loadClaimsBackup(ROOT_A)).not.toBeNull();
    expect(await loadClaimsBackup(ROOT_B)).not.toBeNull();
    expect((await listClaimsBackups()).map((b) => b.claimsRoot).sort()).toEqual(
      [ROOT_A, ROOT_B].sort(),
    );
  });

  it("returns null for an unknown root and for a corrupt file", async () => {
    expect(await loadClaimsBackup(ROOT_A)).toBeNull();
    store.set("zkscatter-claims-backup-" + ROOT_A.toLowerCase() + ".json", "{ not json");
    expect(await loadClaimsBackup(ROOT_A)).toBeNull();
  });

  it("rejects a backup whose internal root disagrees with the file key", async () => {
    // File keyed under ROOT_A but its contents claim ROOT_B (hand-edited).
    store.set(
      "zkscatter-claims-backup-" + ROOT_A.toLowerCase() + ".json",
      JSON.stringify(backup(ROOT_B)),
    );
    expect(await loadClaimsBackup(ROOT_A)).toBeNull();
    expect(await listClaimsBackups()).toHaveLength(0);
  });

  it("treats an unsupported tierCap as corrupt", async () => {
    await saveClaimsBackup({ ...backup(ROOT_A), tierCap: 99 });
    expect(await loadClaimsBackup(ROOT_A)).toBeNull();
  });

  it("listClaimsBackups skips corrupt files instead of throwing", async () => {
    await saveClaimsBackup(backup(ROOT_A));
    store.set("zkscatter-claims-backup-deadbeef.json", "{ broken");
    const list = await listClaimsBackups();
    expect(list).toHaveLength(1);
    expect(list[0]!.claimsRoot).toBe(ROOT_A);
  });
});

describe("a backup's claims rebuild the same claimsRoot (recovery)", () => {
  it("buildClaimsTree over the backed-up claims reproduces the stored root", async () => {
    const recips = [
      { recipient: "0xc1eba383d94c6021160042491a5dfaf1d82694e6", amount: 100n, releaseTime: 1781076887n },
      { recipient: "0x796C1f28c777b8a5851D356EBbc9DeC2ee51137F", amount: 200n, releaseTime: 1781076887n },
    ];
    const batch = splitPayout(await withDeterministicSecrets(recips, 999n, TOKEN), { token: TOKEN })[0]!;
    const { root } = await buildClaimsTree(batch.claims, batch.tier);
    const stored: ClaimsBackup = {
      ...backup(toBytes32Hex(root)),
      claims: batch.claims.map((c) => ({
        recipient: c.recipient,
        amount: c.amount.toString(),
        releaseTime: c.releaseTime.toString(),
        secret: c.secret.toString(),
      })),
    };
    await saveClaimsBackup(stored);

    // Recovery: reconstruct claims (adding the shared token) and rebuild.
    const loaded = (await loadClaimsBackup(stored.claimsRoot))!;
    const tier = [TIER_16].find((t) => t.cap === loaded.tierCap)!;
    const rebuilt = await buildClaimsTree(
      loaded.claims.map((c) => ({
        secret: BigInt(c.secret),
        recipient: c.recipient,
        token: loaded.token,
        amount: BigInt(c.amount),
        releaseTime: BigInt(c.releaseTime),
      })),
      tier,
    );
    expect(toBytes32Hex(rebuilt.root)).toBe(loaded.claimsRoot);
  });
});
