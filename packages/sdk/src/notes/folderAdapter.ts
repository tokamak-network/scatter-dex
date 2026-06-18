/**
 * `NoteStorageAdapter` backed by the user's notes folder via the
 * File System Access API. Mirrors the file naming convention
 * (`zkscatter-note-<leafIndex>-<timestamp>.json`) that
 * `frontend/app/lib/zk/note-storage.ts` writes today, so a folder
 * picked in either app surfaces the same notes.
 *
 * Reads are tolerant of frontend-shaped files that pre-date the
 * SDK's `id` / `label` fields — both are derived deterministically
 * from `commitment` / `leafIndex` so a frontend-deposited note
 * round-trips through Pay's UI without losing identity.
 *
 * Writes always emit the SDK shape (id + label preserved). Frontend's
 * `deserializeFromFile` ignores unknown fields, so the file is still
 * readable on the frontend side after a Pay write.
 */

import {
  hasFolder,
  listFiles,
  removeFile,
  saveFile,
} from "../storage/folder";
import {
  bigintToHex,
  notePreimageFromHex,
  notePreimageToHex,
  type NotePreimageHex,
} from "../util/format";
import type { NoteStorageAdapter, StoredNote } from "./types";

const NOTE_PREFIX = "zkscatter-note-";

interface FolderAdapterOpts {
  /** Restrict reads to one chain. Notes whose serialized `chainId`
   *  doesn't match are skipped. Notes without a `chainId` (older
   *  files) pass through so legacy data stays visible. */
  chainId?: number;
  /** Restrict reads to one wallet. Notes whose serialized `account`
   *  doesn't match are skipped — keeps the same Documents/ workspace
   *  reusable across multiple wallets without each one seeing every
   *  other's funds. Lowercased before compare so a checksummed env
   *  value still matches a lowercased-on-write file. Notes without
   *  an `account` (pre-isolation files, hand-edited drops) pass
   *  through so legacy data stays spendable. */
  accountKey?: string;
}

interface FileShape {
  id?: string;
  label?: string;
  symbol?: string;
  tokenSymbol?: string;
  amount: string;
  commitment: string;
  leafIndex: number;
  status?: "failed";
  failedAt?: number;
  txHash?: string;
  chainId?: number;
  /** Lowercased 0x-prefixed wallet address that wrote this note.
   *  Optional — pre-isolation files don't have it. */
  account?: string;
  createdAt: string | number;
  /** Reuses the SDK-wide hex shape so v1 records (missing pubKeys)
   *  type-check the same way they do on the IDB side. */
  note: NotePreimageHex;
}

/** Build a folder-backed `NoteStorageAdapter`. Throws on `put`,
 *  `remove`, or `clear` when no folder is selected — callers should
 *  guard with `hasFolder()` or wait for `useFolderStorage().ready` in
 *  React contexts. `loadAll` returns `[]` instead of throwing so a
 *  vault that mounts before the folder is picked still gets an empty
 *  list rather than a render-time error.
 *
 *  Identity model: `id` is **content-addressed** from `commitment`
 *  (`c-<hex>`), so a record written by Pay and a record written by
 *  frontend with the same commitment have the same id. This makes
 *  `remove(id)` work across apps and keeps any caller-side dedup-by-
 *  id consistent regardless of which app produced the file. */
export function createFolderNoteAdapter(opts: FolderAdapterOpts = {}): NoteStorageAdapter {
  // Lowercase the wallet filter once at construction, then validate
  // shape. Apps commonly forward a pre-connect placeholder (the
  // literal "anon") when no wallet is attached yet — accepting it
  // here would (a) hide every note tagged with a real address while
  // the wallet finishes loading, and (b) stamp `account: "anon"`
  // onto any note written pre-connect, making it permanently
  // invisible after connect. Treat anything that isn't a 0x +
  // 40-hex address as "no filter" so the placeholder degrades
  // cleanly into the legacy "show everything" behaviour.
  const lowered = opts.accountKey?.toLowerCase();
  const accountFilter =
    lowered !== undefined && /^0x[0-9a-f]{40}$/.test(lowered) ? lowered : undefined;
  let readyPromise: Promise<void> | null = null;
  // Filename cache populated by `loadAll` so `remove` doesn't have
  // to re-walk and re-parse the entire directory just to find the
  // file that holds a given id. Multiple files can map to one id
  // (deposit retries, leafIndex resolution races) — `remove` deletes
  // all of them.
  const filenamesById = new Map<string, string[]>();

  function rememberFilename(id: string, filename: string) {
    const list = filenamesById.get(id);
    if (list) list.push(filename);
    else filenamesById.set(id, [filename]);
  }

  return {
    ready() {
      if (!readyPromise) readyPromise = Promise.resolve();
      return readyPromise;
    },

    async loadAll() {
      if (!hasFolder()) return [];
      const files = await listFiles(
        (name) => name.startsWith(NOTE_PREFIX) && name.endsWith(".json"),
      );
      filenamesById.clear();
      // Same dedup-by-commitment rule as frontend: prefer entries
      // with a resolved leafIndex (≥ 0) over pending `-1`, and the
      // newer `createdAt` between two resolved entries.
      const byCommitment = new Map<string, StoredNote>();
      for (const f of files) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await f.read());
        } catch (err) {
          console.warn(`[folderAdapter] skipped unparseable note file ${f.filename}`, err);
          continue;
        }
        if (!isLikelyFileShape(parsed)) {
          console.warn(`[folderAdapter] skipped malformed note file ${f.filename}`);
          continue;
        }
        let note: StoredNote;
        try {
          note = deserialize(parsed);
        } catch (err) {
          // V1 notes (missing pubKeyAx/Ay) and any other unrecoverable
          // shapes hit here. Don't let them disappear silently — the
          // user has to know they exist before they can re-deposit.
          console.warn(
            `[folderAdapter] skipped note file ${f.filename} — re-deposit required`,
            err,
          );
          continue;
        }
        if (opts.chainId !== undefined && note.chainId !== undefined && note.chainId !== opts.chainId) {
          continue;
        }
        // Wallet isolation: a note tagged with another wallet stays
        // hidden, since only that wallet's secret can spend it.
        // `account === undefined` is treated as legacy / cross-wallet
        // and stays visible (matches the chainId branch above).
        if (accountFilter !== undefined && note.account !== undefined && note.account !== accountFilter) {
          continue;
        }
        rememberFilename(note.id, f.filename);
        const key = note.commitment.toString();
        const prev = byCommitment.get(key);
        if (!prev) {
          byCommitment.set(key, note);
        } else {
          const prevResolved = prev.leafIndex >= 0;
          const curResolved = note.leafIndex >= 0;
          if (
            (!prevResolved && curResolved) ||
            (prevResolved === curResolved && note.createdAt > prev.createdAt)
          ) {
            byCommitment.set(key, note);
          }
        }
      }
      const notes = [...byCommitment.values()];
      notes.sort((a, b) => a.createdAt - b.createdAt);
      return notes;
    },

    async put(note: StoredNote) {
      if (!hasFolder()) throw new Error("No folder selected");
      // Filename keeps frontend's convention but appends a short id
      // suffix so two `put`s in the same millisecond with the same
      // leafIndex (e.g. two pending deposits at -1) don't collide.
      const idSuffix = note.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
      const filename = `${NOTE_PREFIX}${note.leafIndex}-${Date.now()}-${idSuffix}.json`;
      // Stamp the depositing wallet at write time so call sites
      // (vaultProvider.add) don't each have to remember to plumb
      // it through. `note.account` already set wins — leaves a door
      // open for the rare cross-wallet share without forcing every
      // caller to pass `account` explicitly.
      const stamped: StoredNote =
        note.account === undefined && accountFilter !== undefined
          ? { ...note, account: accountFilter }
          : note;
      // Write the new file *before* deleting any prior versions so a
      // mid-call failure leaves the data intact rather than wiping
      // a record that's no longer recoverable. The folder accepts
      // duplicate-by-commitment files (loadAll dedupes); cleanup is
      // a best-effort optimisation.
      await saveFile(filename, JSON.stringify(serialize(stamped), null, 2));
      const stale = filenamesById.get(note.id);
      filenamesById.set(note.id, [filename]);
      if (stale && stale.length > 0) {
        // Cleanup of the prior generation is best-effort: the new
        // file is already on disk + carries authoritative state, so
        // a `removeEntry` failure (file held open by the OS,
        // permission downgraded, NoModificationAllowedError) must
        // not throw past the caller. Otherwise upstream consumers
        // like `vaultProvider.setLeafIndex` reject and the in-memory
        // note never sees the resolved `leafIndex`, leaving the
        // user unable to spend a deposit that's actually settled
        // on-chain. `loadAll`'s dedup-by-commitment handles the
        // resulting duplicate gracefully.
        await Promise.all(
          stale.map((f) =>
            removeFile(f).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn(`[folderAdapter] failed to remove stale note file ${f}`, err);
            }),
          ),
        );
      }
    },

    async remove(id: string) {
      if (!hasFolder()) return;
      const cached = filenamesById.get(id);
      if (cached) {
        // removeFile is best-effort: a `NoModificationAllowedError`
        // (file held open by the OS, cloud-sync indexer, an editor,
        // …) must not surface as a thrown error, otherwise the
        // upstream `vault.remove(id)` rejects mid-await and the
        // React-state filter never runs — the spent note stays in
        // the panel and blocks the next withdraw. `loadAll` dedupes
        // by commitment so a stale file left behind doesn't
        // double-count.
        await Promise.all(
          cached.map((filename) =>
            removeFile(filename).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn(`[folderAdapter] failed to remove ${filename}`, err);
            }),
          ),
        );
        filenamesById.delete(id);
        return;
      }
      // Cold path: `remove` was called before the cache was warmed by
      // `loadAll`. Walk the directory once, remove matching files,
      // keep the cache empty (caller will re-warm via the next
      // `loadAll`).
      const files = await listFiles(
        (name) => name.startsWith(NOTE_PREFIX) && name.endsWith(".json"),
      );
      const matches: string[] = [];
      for (const f of files) {
        try {
          const parsed = JSON.parse(await f.read()) as unknown;
          if (!isLikelyFileShape(parsed)) continue;
          const note = deserialize(parsed);
          if (note.id !== id) continue;
          // Respect the same chainId scope `loadAll` and the warm
          // cache use, otherwise a cross-chain `remove(id)` could
          // delete a note belonging to a different network that
          // happens to share the (content-addressed) id.
          if (
            opts.chainId !== undefined &&
            note.chainId !== undefined &&
            note.chainId !== opts.chainId
          ) {
            continue;
          }
          // Mirror the loadAll scope so a cross-wallet `remove(id)`
          // can't delete a file the connected wallet doesn't own.
          if (
            accountFilter !== undefined &&
            note.account !== undefined &&
            note.account !== accountFilter
          ) {
            continue;
          }
          matches.push(f.filename);
        } catch {
          /* skip malformed */
        }
      }
      await Promise.all(matches.map((filename) => removeFile(filename)));
    },

    async clear() {
      if (!hasFolder()) return;
      const files = await listFiles(
        (name) => name.startsWith(NOTE_PREFIX) && name.endsWith(".json"),
      );
      filenamesById.clear();
      await Promise.all(files.map((f) => removeFile(f.filename)));
    },
  };
}

/** Lightweight runtime check for the file shape — `JSON.parse`
 *  returns `unknown`, so we narrow before trusting the cast. Misses
 *  some malformed inputs but covers the common "user opened the file
 *  in a text editor and saved blank/wrong" case without re-running
 *  every field through a schema validator. */
function isLikelyFileShape(p: unknown): p is FileShape {
  if (!p || typeof p !== "object") return false;
  const v = p as Record<string, unknown>;
  return (
    typeof v.commitment === "string" &&
    typeof v.leafIndex === "number" &&
    typeof v.amount === "string" &&
    typeof v.note === "object" &&
    v.note !== null
  );
}

// ─── Serialization ───────────────────────────────────────────

function serialize(n: StoredNote): FileShape & { warning: string } {
  return {
    // Skip writing `id` — it's content-addressed from `commitment`.
    label: n.label,
    symbol: n.symbol,
    amount: n.amount,
    commitment: bigintToHex(n.commitment),
    leafIndex: n.leafIndex,
    status: n.status,
    failedAt: n.failedAt,
    txHash: n.txHash,
    chainId: n.chainId,
    // Persist the depositing wallet so future loads can isolate per
    // account. Lowercased on the way in — the loadAll filter does
    // the same to its options, but normalising both sides means a
    // hand-edited file with checksum casing still matches.
    account: n.account?.toLowerCase(),
    createdAt: new Date(n.createdAt).toISOString(),
    note: notePreimageToHex(n.note),
    warning: "Keep this file secret. Anyone with this data can withdraw your funds.",
  };
}

function deserialize(parsed: FileShape): StoredNote {
  if (!parsed?.note) throw new Error("Missing note preimage");
  // `notePreimageFromHex` carries the canonical v1 → "re-deposit
  // required" error so the wording stays consistent with the IDB
  // adapter and any future consumer.
  const note = notePreimageFromHex(parsed.note);
  const commitment = BigInt(parsed.commitment);
  // `id` is content-addressed — a record written by Pay and the
  // same commitment written by frontend resolve to the same id, so
  // `remove(id)` works regardless of which app produced the file
  // and dedup-by-id stays consistent across apps. Any `id` field
  // present in the file is ignored.
  const id = idForCommitment(commitment);
  const symbol = parsed.symbol ?? parsed.tokenSymbol ?? "";
  const label = parsed.label ?? `lot-${parsed.leafIndex >= 0 ? parsed.leafIndex : "pending"}`;
  const createdAt =
    typeof parsed.createdAt === "number"
      ? parsed.createdAt
      : new Date(parsed.createdAt).getTime();
  return {
    id,
    label,
    symbol,
    amount: parsed.amount,
    note,
    commitment,
    leafIndex: parsed.leafIndex,
    status: parsed.status,
    failedAt: parsed.failedAt,
    txHash: parsed.txHash,
    chainId: parsed.chainId,
    account: parsed.account?.toLowerCase(),
    createdAt,
  };
}

/** Content-addressed id for a commitment. Hex of the commitment is
 *  unique per note (Poseidon collision resistance) and matches the
 *  same record across reads from Pay or frontend. Exported so vault
 *  providers stamp the same id at `put` time, which keeps the
 *  in-memory vault and the on-disk record consistent. */
export function idForCommitment(commitment: bigint): string {
  return "c-" + commitment.toString(16);
}
