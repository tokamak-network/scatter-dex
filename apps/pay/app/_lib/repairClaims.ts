import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI, eqAddr, isConfiguredAddress } from "@zkscatter/sdk";
import { buildClaimsTree, getMerkleProof, toBytes32Hex, TIERS } from "@zkscatter/sdk/zk";
import {
  decodeClaimPackage,
  encodeClaimPackage,
  type ClaimPackage,
} from "@zkscatter/sdk/notes";
import type { ClaimsBackup, RunRecord } from "@zkscatter/sdk/storage";

/** Rebuild the per-recipient claim packages from a claims backup. The
 *  backup holds the claim inputs (secret / recipient / amount /
 *  releaseTime) for one `claimsRoot`; this reconstructs the Merkle tree
 *  and emits one ClaimPackage per leaf, mirroring `finalizeRealSettle`'s
 *  package shape. Throws if the rebuilt root disagrees with the backup's
 *  stored root — that means the stored inputs are inconsistent and the
 *  packages would point at a settlement that doesn't exist. */
export async function rebuildClaimPackages(backup: ClaimsBackup): Promise<ClaimPackage[]> {
  const tier = TIERS.find((t) => t.cap === backup.tierCap);
  if (!tier) throw new Error(`Unsupported tierCap ${backup.tierCap} in claims backup`);
  const claims = backup.claims.map((c) => ({
    secret: BigInt(c.secret),
    recipient: c.recipient,
    token: backup.token,
    amount: BigInt(c.amount),
    releaseTime: BigInt(c.releaseTime),
  }));
  const { root, layers } = await buildClaimsTree(claims, tier);
  if (toBytes32Hex(root).toLowerCase() !== backup.claimsRoot.toLowerCase()) {
    throw new Error(
      "Rebuilt claimsRoot does not match the backup — claim inputs are inconsistent.",
    );
  }
  return claims.map((c, i): ClaimPackage => {
    const proof = getMerkleProof(layers, i);
    return {
      version: 1,
      chainId: backup.chainId,
      settlementAddress: backup.settlementAddress,
      claimsRoot: backup.claimsRoot,
      recipient: ethers.getAddress(c.recipient),
      token: ethers.getAddress(backup.token),
      tokenSymbol: backup.tokenSymbol,
      tokenDecimals: backup.tokenDecimals,
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
      secret: c.secret.toString(),
      leafIndex: i,
      pathElements: proof.pathElements.map((e) => e.toString()),
      pathIndices: proof.pathIndices,
      ...(backup.senderLabel ? { senderLabel: backup.senderLabel } : {}),
      ...(backup.runLabel ? { runLabel: backup.runLabel } : {}),
      ...(backup.relayerUrl ? { relayerUrl: backup.relayerUrl } : {}),
    };
  });
}

/** The claimsRoot the record's already-issued packages point at, or null
 *  when no recipient carries a (decodable) package. */
export function recordClaimsRoot(record: RunRecord): string | null {
  for (const r of record.recipients) {
    if (!r.claimPackage) continue;
    try {
      return decodeClaimPackage(r.claimPackage).claimsRoot;
    } catch {
      // try the next row
    }
  }
  return null;
}

function addrCounts(addrs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of addrs) {
    const k = a.toLowerCase();
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function countsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Whether a backup belongs to this run. A Pay run is single-batch
 *  (MAX_BATCHES_PER_RUN = 1), so one run maps to exactly one backup.
 *  Strongest signal: the per-payout seed, persisted on both the run
 *  record (PR #1000) and the backup (PR #1001) — it pins the pair even
 *  when an unrelated payout reused the same recipients + token + chain.
 *  Legacy records without a seed fall back to a recipient-address
 *  MULTISET match (counts included, so duplicate recipients don't
 *  collapse). Amounts aren't compared (record stores display units, the
 *  backup token-raw); the on-chain-root check downstream is the final
 *  arbiter. */
function backupMatchesRun(backup: ClaimsBackup, record: RunRecord): boolean {
  if (backup.chainId !== record.chainId) return false;
  if (!eqAddr(backup.token, record.tokenAddress)) return false;
  if (backup.payoutSeed && record.payoutSeed) {
    return backup.payoutSeed === record.payoutSeed;
  }
  return countsEqual(
    addrCounts(record.recipients.map((r) => r.address)),
    addrCounts(backup.claims.map((c) => c.recipient)),
  );
}

/** Overlay rebuilt packages onto a record by leaf index (= rowIndex for
 *  a single-batch run), with a recipient-address sanity check so a
 *  misaligned backup can't write the wrong recipient's package onto a
 *  row. Matching positionally (not by address) keeps duplicate-address
 *  rows correct — an address Map would collapse them. */
function applyPackagesToRecord(record: RunRecord, packages: ClaimPackage[]): RunRecord {
  const byLeaf = new Map(packages.map((p) => [p.leafIndex, p]));
  const recipients = record.recipients.map((r) => {
    const pkg = byLeaf.get(r.rowIndex);
    return pkg && eqAddr(pkg.recipient, r.address)
      ? { ...r, claimPackage: encodeClaimPackage(pkg) }
      : r;
  });
  return { ...record, recipients };
}

/** Probe a root's on-chain settlement, swallowing probe errors (a
 *  malformed root in a hand-edited backup, or a transient RPC failure)
 *  so one bad candidate is skipped rather than aborting the whole
 *  repair. */
async function safeIsRootSettled(
  isRootSettled: (claimsRoot: string) => Promise<boolean>,
  claimsRoot: string,
): Promise<boolean> {
  try {
    return await isRootSettled(claimsRoot);
  } catch {
    return false;
  }
}

export type RepairResult =
  | { status: "ok" } // record's root is already on-chain — nothing to repair
  | { status: "no-backup" } // no claims backup matches this run
  | { status: "no-settled-root" } // matching backups exist but none is on-chain
  | { status: "repaired"; record: RunRecord; settledRoot: string; recoveredCount: number };

/** Diagnose and (if possible) repair a run whose persisted claim links
 *  point at a claimsRoot that was never settled on-chain — the relayer-
 *  delay stranding bug. Finds the claims backup for this run whose root
 *  IS on-chain, rebuilds the packages from it, and overlays them onto the
 *  record. `isRootSettled` is injected so the orchestration is testable
 *  without a live provider; the UI passes {@link makeIsRootSettled}. */
export async function repairRunClaims(args: {
  record: RunRecord;
  backups: ClaimsBackup[];
  isRootSettled: (claimsRoot: string) => Promise<boolean>;
}): Promise<RepairResult> {
  const { record, backups, isRootSettled } = args;

  const currentRoot = recordClaimsRoot(record);
  if (currentRoot && (await safeIsRootSettled(isRootSettled, currentRoot))) {
    return { status: "ok" };
  }

  const candidates = backups.filter((b) => backupMatchesRun(b, record));
  if (candidates.length === 0) return { status: "no-backup" };

  let settled: ClaimsBackup | null = null;
  for (const b of candidates) {
    if (await safeIsRootSettled(isRootSettled, b.claimsRoot)) {
      settled = b;
      break;
    }
  }
  if (!settled) return { status: "no-settled-root" };

  const packages = await rebuildClaimPackages(settled);
  return {
    status: "repaired",
    record: applyPackagesToRecord(record, packages),
    settledRoot: settled.claimsRoot,
    recoveredCount: packages.length,
  };
}

/** Build an `isRootSettled` probe backed by the on-chain
 *  `claimsGroups(root).token != 0` check, for the UI to pass into
 *  {@link repairRunClaims}. */
export function makeIsRootSettled(
  readProvider: ethers.Provider,
  settlementAddress: string,
): (claimsRoot: string) => Promise<boolean> {
  const settlement = new ethers.Contract(
    settlementAddress,
    PRIVATE_SETTLEMENT_ABI,
    readProvider,
  );
  return async (claimsRoot: string) => {
    const group = (await settlement.claimsGroups(claimsRoot)) as { token: string };
    return isConfiguredAddress(group.token);
  };
}
