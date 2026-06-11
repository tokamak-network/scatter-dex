import { describe, expect, it } from "vitest";
import {
  buildClaimsTree,
  splitPayout,
  toBytes32Hex,
  withDeterministicSecrets,
} from "@zkscatter/sdk/zk";
import { decodeClaimPackage, encodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import type { ClaimsBackup, RunRecord } from "@zkscatter/sdk/storage";
import { rebuildClaimPackages, repairRunClaims } from "../app/_lib/repairClaims";

const TOKEN = "0xa30fe40285B8f5c0457DbC3B7C8A280373c40044";
const SETTLE = "0x9546B0A1f9cf52405645f3EFD86E06f7ea76Ef74";
const CHAIN = 11155111;
const recips = [
  { recipient: "0xc1eba383d94c6021160042491a5dfaf1d82694e6", amount: 100n, releaseTime: 1781076887n },
  { recipient: "0x796C1f28c777b8a5851D356EBbc9DeC2ee51137F", amount: 200n, releaseTime: 1781076887n },
];

async function makeBackup(seed: bigint): Promise<ClaimsBackup> {
  const batch = splitPayout(await withDeterministicSecrets(recips, seed, TOKEN), { token: TOKEN })[0]!;
  const { root } = await buildClaimsTree(batch.claims, batch.tier);
  return {
    version: 1,
    createdAt: 0,
    chainId: CHAIN,
    settlementAddress: SETTLE,
    claimsRoot: toBytes32Hex(root),
    tierCap: 16,
    token: TOKEN,
    tokenSymbol: "TON",
    tokenDecimals: 18,
    payoutSeed: seed.toString(),
    claims: batch.claims.map((c) => ({
      recipient: c.recipient,
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
      secret: c.secret.toString(),
    })),
  };
}

function makeRecord(packages: ClaimPackage[]): RunRecord {
  return {
    id: "p_test",
    label: "test-ton-1",
    operatorAddress: "0xsender",
    category: "payroll",
    createdAt: 0,
    settledAt: 0,
    chainId: CHAIN,
    txHash: "0x" + "0".repeat(64),
    tokenSymbol: "TON",
    tokenAddress: TOKEN,
    totalAmount: "300",
    recipients: packages.map((p, i) => ({
      rowIndex: i,
      name: `r${i}`,
      address: p.recipient.toLowerCase(),
      amount: "100",
      status: "available" as const,
      claimPackage: encodeClaimPackage(p),
    })),
    notifications: [],
  };
}

describe("rebuildClaimPackages", () => {
  it("rebuilds packages whose root matches the backup", async () => {
    const b = await makeBackup(111n);
    const pkgs = await rebuildClaimPackages(b);
    expect(pkgs).toHaveLength(2);
    expect(pkgs.every((p) => p.claimsRoot === b.claimsRoot)).toBe(true);
  });

  it("throws when the backed-up inputs don't reproduce the stored root", async () => {
    const b = await makeBackup(111n);
    b.claims[0]!.secret = "999"; // tamper → tree no longer hashes to claimsRoot
    await expect(rebuildClaimPackages(b)).rejects.toThrow(/does not match/i);
  });
});

describe("repairRunClaims", () => {
  it("repairs a run whose packages point at a stale (never-settled) root", async () => {
    const stale = await makeBackup(1n); // packages persisted on the record
    const real = await makeBackup(2n); // the root that actually settled on-chain
    expect(stale.claimsRoot).not.toBe(real.claimsRoot);
    const record = makeRecord(await rebuildClaimPackages(stale));

    const res = await repairRunClaims({
      record,
      backups: [real],
      isRootSettled: async (root) => root === real.claimsRoot,
    });

    expect(res.status).toBe("repaired");
    if (res.status !== "repaired") return;
    expect(res.settledRoot).toBe(real.claimsRoot);
    expect(res.recoveredCount).toBe(2);
    for (const r of res.record.recipients) {
      expect(decodeClaimPackage(r.claimPackage!).claimsRoot).toBe(real.claimsRoot);
    }
  });

  it("returns ok when the record's root is already on-chain", async () => {
    const real = await makeBackup(3n);
    const record = makeRecord(await rebuildClaimPackages(real));
    const res = await repairRunClaims({
      record,
      backups: [real],
      isRootSettled: async () => true,
    });
    expect(res.status).toBe("ok");
  });

  it("returns no-backup when no backup matches the run (different token)", async () => {
    const stale = await makeBackup(1n);
    const record = makeRecord(await rebuildClaimPackages(stale));
    const otherToken = { ...(await makeBackup(2n)), token: "0x0000000000000000000000000000000000000001" };
    const res = await repairRunClaims({
      record,
      backups: [otherToken],
      isRootSettled: async () => false,
    });
    expect(res.status).toBe("no-backup");
  });

  it("returns no-settled-root when a matching backup exists but none is on-chain", async () => {
    const stale = await makeBackup(1n);
    const real = await makeBackup(2n);
    const record = makeRecord(await rebuildClaimPackages(stale));
    const res = await repairRunClaims({
      record,
      backups: [real],
      isRootSettled: async () => false,
    });
    expect(res.status).toBe("no-settled-root");
  });
});
