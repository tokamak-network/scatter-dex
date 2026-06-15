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

/** noteIds pinned by OPEN orders across EVERY product's per-order
 *  files for (`chainId`, `accountKey`). Escrow notes and funds are
 *  shared between products (Pay, Pro), so a note funding an open order
 *  in one product must read as locked in the other — otherwise a
 *  withdraw there burns the note's nullifier and strands the order.
 *
 *  Files are `zkscatter-<app>-order-<chainId>-<accountKey>-<id>.json`,
 *  one `WireOrder` object each (see `apps/pro/app/lib/orders.tsx`).
 *  `accountKey` scopes to the connected wallet — another wallet's
 *  orders can't lock this wallet's notes. `excludeApp` skips the
 *  caller's own product. Per-file errors are swallowed (a corrupt or
 *  foreign file must never hide a real lock); a missing/unavailable
 *  folder yields an empty set. */
export async function loadCrossAppLockedNoteIds(
  chainId: number,
  accountKey: string,
  opts: CrossAppLockOptions = {},
): Promise<Set<string>> {
  const list = opts.listFilesImpl ?? defaultListFiles;
  const nowMs = opts.nowMs ?? Date.now();
  const exclude = opts.excludeApp?.trim().toLowerCase();
  const acct = accountKey.toLowerCase();
  // Capture the product slug so we can honour `excludeApp`.
  const re = new RegExp(
    `^zkscatter-([a-z0-9]+)-order-${chainId}-${escapeRegExp(acct)}-.+\\.json$`,
  );
  const locked = new Set<string>();
  let entries: FolderFileEntry[];
  try {
    entries = await list((name) => {
      const m = re.exec(name);
      return !!m && m[1] !== exclude;
    });
  } catch {
    return locked; // folder unavailable → no locks known
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
      if (orderRowLocksNote(row, nowMs)) locked.add(row.noteId as string);
    }),
  );
  return locked;
}
