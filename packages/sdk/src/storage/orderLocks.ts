import { listFiles as defaultListFiles, type FolderFileEntry } from "./folder";

/** Order statuses that pin (lock) their funding note from reuse.
 *  Mirrors `apps/pro` `noteStatus.OPEN_STATUSES`: `claimed` and
 *  `cancelled` are terminal — the funding note is gone (settled) or
 *  rotated (cancelled) — so they never lock. Kept in lockstep with the
 *  Pro classifier; if one changes the other must too. */
const OPEN_ORDER_STATUSES: ReadonlySet<string> = new Set(["matching", "claimable"]);

/** Tolerant subset of `apps/pro` `WireOrder` — only the fields the
 *  cross-app lock check reads. Everything else in the file is ignored
 *  so a schema bump elsewhere can't break lock detection. */
interface OrderLockRow {
  status?: unknown;
  noteId?: unknown;
  /** Settle deadline as a hex unix-seconds string (`WireOrder.expiryHex`). */
  expiryHex?: unknown;
  /** Change-note commitment as a 0x-hex string (`WireOrder.changeCommitmentHex`).
   *  Present when the order left a residual; used to flag the phantom
   *  change note of an expired matching order as discarded. */
  changeCommitmentHex?: unknown;
}

/** True when `expiryHex` (a hex unix-seconds string) is at/before
 *  `nowMs`. Missing/garbage expiry → never expired, matching
 *  `apps/pro` `isOrderExpired` (pre-`expiry` rows are never expired).
 *  Exported for unit tests. */
export function isOrderExpiredHex(expiryHex: unknown, nowMs: number): boolean {
  // Only a clean 0x-hex string (the `WireOrder.expiryHex` format) counts as
  // a real deadline. `Number()` coerces empties/whitespace ("", "   ") to 0
  // and other junk unpredictably, which would read as "expired at epoch" and
  // silently FREE a locked note. Anything not strictly 0x-hex is treated as
  // "no deadline → never expired", keeping the order LOCKED (the safe side).
  if (typeof expiryHex !== "string" || !/^0x[0-9a-fA-F]+$/.test(expiryHex)) {
    return false;
  }
  const sec = Number(expiryHex);
  if (!Number.isFinite(sec)) return false; // absurdly long hex → Infinity
  return sec * 1000 <= nowMs;
}

/** Whether a persisted order row currently pins its funding note.
 *  `claimable` always locks (past cancel, awaiting recipient claims);
 *  `matching` locks only until its on-chain `expiry` passes —
 *  post-expiry settle is blocked (`SettleVerifyLib`), so the funding
 *  note becomes recoverable via withdraw. Mirrors `apps/pro`
 *  `buildOrderIndex`'s lock rule so the two can't disagree. Exported
 *  for unit tests. */
export function orderRowLocksNote(row: OrderLockRow, nowMs: number): boolean {
  if (typeof row?.noteId !== "string" || row.noteId.length === 0) return false;
  if (typeof row.status !== "string" || !OPEN_ORDER_STATUSES.has(row.status)) return false;
  if (row.status === "matching" && isOrderExpiredHex(row.expiryHex, nowMs)) return false;
  return true;
}

export interface CrossAppLockOptions {
  /** Product slug to skip — the caller already has its own orders in
   *  memory with full detail (e.g. Pro passes `"pro"`). Case-insensitive. */
  excludeApp?: string;
  /** Wall clock for the expiry check; defaults to `Date.now()`. */
  nowMs?: number;
  /** Injectable directory lister; defaults to folder storage. Tests
   *  pass a stub. */
  listFilesImpl?: (matches?: (filename: string) => boolean) => Promise<FolderFileEntry[]>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Content-addressed note id from a commitment's 0x-hex string. Mirrors
 *  `notes/folderAdapter` `idForCommitment` (`"c-" + commitment.toString(16)`)
 *  — replicated here so the storage layer needn't import the notes layer.
 *  Returns null for a non-hex string. */
function noteIdForCommitmentHex(hex: unknown): string | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  return "c-" + BigInt(hex).toString(16);
}

export interface CrossAppNoteStates {
  /** noteIds funding an OPEN, non-expired order — reconciled but not
   *  directly spendable (withdrawing strands the order). */
  lockedNoteIds: Set<string>;
  /** noteIds of phantom CHANGE notes from `matching` orders that expired
   *  before settling. The settleAuth never ran, so the change commitment
   *  will never be inserted on-chain — a `leafIndex < 0` note matching one
   *  is a ghost, not a real pending deposit, and must not inflate the
   *  pending balance. Mirrors apps/pro noteStatus's `discarded`. */
  discardedNoteIds: Set<string>;
}

/** Cross-product note states derived from EVERY product's per-order files
 *  for (`chainId`, `accountKey`). Escrow notes/funds are shared between
 *  products (Pay, Pro) but orders live in per-app files, so each product
 *  must read the others' orders to classify a shared note correctly.
 *
 *  Files are `zkscatter-<app>-order-<chainId>-<accountKey>-<id>.json`, one
 *  `WireOrder` object each (see `apps/pro/app/lib/orders.tsx`). `accountKey`
 *  scopes to the connected wallet. `excludeApp` skips the caller's own
 *  product. Per-file errors are swallowed (a corrupt/foreign file must
 *  never hide a real lock); a missing folder yields empty sets. */
export async function loadCrossAppNoteStates(
  chainId: number,
  accountKey: string,
  opts: CrossAppLockOptions = {},
): Promise<CrossAppNoteStates> {
  const list = opts.listFilesImpl ?? defaultListFiles;
  const nowMs = opts.nowMs ?? Date.now();
  const exclude = opts.excludeApp?.trim().toLowerCase();
  const acct = accountKey.toLowerCase();
  // Capture the product slug so we can honour `excludeApp`.
  const re = new RegExp(
    `^zkscatter-([a-z0-9]+)-order-${chainId}-${escapeRegExp(acct)}-.+\\.json$`,
  );
  const lockedNoteIds = new Set<string>();
  const discardedNoteIds = new Set<string>();
  let entries: FolderFileEntry[];
  try {
    entries = await list((name) => {
      const m = re.exec(name);
      return !!m && m[1] !== exclude;
    });
  } catch {
    return { lockedNoteIds, discardedNoteIds }; // folder unavailable
  }
  await Promise.allSettled(
    entries.map(async (entry) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await entry.read());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const row = parsed as OrderLockRow;
      if (orderRowLocksNote(row, nowMs)) lockedNoteIds.add(row.noteId as string);
      // Phantom change note: a matching order that expired before settling.
      if (row.status === "matching" && isOrderExpiredHex(row.expiryHex, nowMs)) {
        const id = noteIdForCommitmentHex(row.changeCommitmentHex);
        if (id) discardedNoteIds.add(id);
      }
    }),
  );
  return { lockedNoteIds, discardedNoteIds };
}

/** Convenience wrapper returning just the locked noteIds — for callers
 *  (e.g. the withdraw submit guard) that don't need the discarded set. */
export async function loadCrossAppLockedNoteIds(
  chainId: number,
  accountKey: string,
  opts: CrossAppLockOptions = {},
): Promise<Set<string>> {
  return (await loadCrossAppNoteStates(chainId, accountKey, opts)).lockedNoteIds;
}
