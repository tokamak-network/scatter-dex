/**
 * Claims backup — a durable, per-`claimsRoot` snapshot of the claim
 * inputs (recipient, amount, releaseTime, secret) written to the
 * user-picked folder BEFORE a settle is dispatched to the relayer.
 *
 * Why it exists: the operator's `RunRecord` is written only after the
 * settle confirms, and it holds exactly one set of claim packages. If a
 * settle lands on-chain but the record is never written (a crash, or a
 * relayer that returns a different attempt's tx hash), the secrets for
 * the root that actually settled can be lost — and the contract has no
 * refund path, so the funds are stranded. Persisting the claim inputs
 * keyed by `claimsRoot` up front means every root that can possibly land
 * on-chain has recoverable secrets. Keying by root makes distinct settle
 * attempts write distinct files (never overwriting each other), while
 * re-writing the same root is idempotent. The recovery tool reads these
 * back to rebuild claim links for whichever root the chain registered.
 */

import { hasFolder, listFiles, loadFile, saveFile } from "./folder";

const PREFIX = "zkscatter-claims-backup-";
const SUFFIX = ".json";

/** One claim's recoverable inputs. `index` in the `claims` array is the
 *  leaf index. All numerics are decimal strings (JSON-safe bigints). */
export interface ClaimsBackupClaim {
  recipient: string;
  amount: string;
  releaseTime: string;
  secret: string;
}

export interface ClaimsBackup {
  version: 1;
  /** Unix seconds when the backup was written (before dispatch). */
  createdAt: number;
  chainId: number;
  settlementAddress: string;
  /** 0x-prefixed bytes32 — also the file key. */
  claimsRoot: string;
  /** Claims-tree capacity the settle proved against (16 | 64 | 128);
   *  doubles as the on-chain group `tier`. Needed to rebuild the tree at
   *  the right depth during recovery. */
  tierCap: number;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Per-payout seed the secrets were derived from, when available —
   *  lets recovery cross-check / regenerate. */
  payoutSeed?: string;
  runLabel?: string;
  senderLabel?: string;
  relayerUrl?: string;
  /** Index = leaf index. */
  claims: ClaimsBackupClaim[];
}

function fileFor(claimsRoot: string): string {
  return `${PREFIX}${claimsRoot.toLowerCase()}${SUFFIX}`;
}

/** Supported claims-tree capacities (= on-chain group tier). Recovery
 *  maps `tierCap` → CircuitTier, so an out-of-range value is corrupt. */
const TIER_CAPS = new Set([16, 64, 128]);

function isValidClaim(c: unknown): c is ClaimsBackupClaim {
  if (!c || typeof c !== "object") return false;
  const v = c as Record<string, unknown>;
  return (
    typeof v.recipient === "string" &&
    typeof v.amount === "string" &&
    typeof v.releaseTime === "string" &&
    typeof v.secret === "string"
  );
}

function isValidBackup(b: unknown): b is ClaimsBackup {
  if (!b || typeof b !== "object") return false;
  const v = b as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.createdAt === "number" &&
    typeof v.chainId === "number" &&
    typeof v.settlementAddress === "string" &&
    typeof v.claimsRoot === "string" &&
    typeof v.tierCap === "number" &&
    TIER_CAPS.has(v.tierCap) &&
    typeof v.token === "string" &&
    typeof v.tokenSymbol === "string" &&
    typeof v.tokenDecimals === "number" &&
    Array.isArray(v.claims) &&
    v.claims.every(isValidClaim)
  );
}

/** Persist a claims backup keyed by its `claimsRoot`. Call BEFORE
 *  dispatching the settle so the secrets survive a crash / divergence.
 *  Distinct roots write distinct files; the same root overwrites
 *  idempotently. Throws if the folder write fails — the caller should
 *  treat that as "don't dispatch without a recoverable backup". */
export async function saveClaimsBackup(backup: ClaimsBackup): Promise<void> {
  await saveFile(fileFor(backup.claimsRoot), JSON.stringify(backup, null, 2));
}

/** Load the backup for a specific `claimsRoot`, or `null` if none /
 *  corrupt. */
export async function loadClaimsBackup(
  claimsRoot: string,
): Promise<ClaimsBackup | null> {
  if (!hasFolder()) return null;
  let text: string | null;
  try {
    text = await loadFile(fileFor(claimsRoot));
  } catch {
    return null; // FS read failure — treat as "no backup", per the contract
  }
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isValidBackup(parsed)) return null;
  // Guard against a hand-edited / mis-keyed file: the contents must
  // belong to the root we looked up, or callers would act on the wrong
  // secrets.
  if (parsed.claimsRoot.toLowerCase() !== claimsRoot.toLowerCase()) return null;
  return parsed;
}

/** List every valid claims backup in the folder. Corrupt / unparseable
 *  files are skipped rather than throwing, so one bad file can't hide
 *  the rest from the recovery UI. */
export async function listClaimsBackups(): Promise<ClaimsBackup[]> {
  if (!hasFolder()) return [];
  const files = await listFiles(
    (name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX),
  );
  // Read concurrently; allSettled so one unreadable/corrupt file can't
  // reject the whole list (and never leaves an unhandled rejection).
  const settled = await Promise.allSettled(
    files.map(async (f) => {
      const parsed: unknown = JSON.parse(await f.read());
      if (!isValidBackup(parsed)) throw new Error("invalid claims backup");
      // Drop a file whose internal root disagrees with its filename key
      // (e.g. copied/renamed) so the list never surfaces a misattributed
      // backup.
      if (fileFor(parsed.claimsRoot) !== f.filename) {
        throw new Error("claims backup filename/root mismatch");
      }
      return parsed;
    }),
  );
  return settled
    .filter((r): r is PromiseFulfilledResult<ClaimsBackup> => r.status === "fulfilled")
    .map((r) => r.value);
}
