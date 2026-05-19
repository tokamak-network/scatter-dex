import type { OrderRecord } from "./orders";
import type { VaultNote } from "./vault";

/** Where a vault note sits in the deposit → order → settle / cancel
 *  lifecycle, derived from `(note, orders)` rather than stored.
 *
 *  - `available`: on-chain reconciled (leafIndex ≥ 0) and not the
 *    funding note of any open order. Free to spend in a new order
 *    or to withdraw.
 *  - `locked`:    on-chain reconciled and funds an open order
 *    (status `matching` or `claimable`). Spending it elsewhere
 *    would race the relayer; the panel needs to show it as
 *    earmarked so the user doesn't double-commit. Release paths
 *    depend on the pinning order's status: `matching` orders are
 *    cancellable (cancel circuit rotates the commitment so the
 *    same balance is immediately re-available under a fresh
 *    salt); `claimable` orders are already past cancel — the
 *    lock clears once the recipient(s) claim and the funding
 *    note's nullifier hits chain (ClaimReconciler then removes
 *    the note locally).
 *  - `pending`:   leafIndex < 0 — either a freshly-deposited note
 *    whose `CommitmentInserted` event hasn't been reconciled into
 *    the in-memory tree yet, or a change note pre-saved at
 *    order-submit whose residual commitment only lands when the
 *    order settles. Either way, not yet spendable. */
export type NoteStatus = "available" | "locked" | "pending";

export interface NoteStatusInfo {
  status: NoteStatus;
  /** When `status === "locked"`, the open order pinning this note.
   *  Undefined for the other two states. */
  lockedByOrder?: OrderRecord;
  /** When `status === "pending"` AND the note is the residual of a
   *  not-yet-settled order, the order it came from. Undefined for
   *  ordinary fresh-deposit pendings (no parent order). Surfaced
   *  so the badge can read "Pending change from ord-3" instead of
   *  just "Pending". */
  pendingFromOrder?: OrderRecord;
}

/** Open-order statuses that pin a funding note (lock it from
 *  reuse). Mirrors ClaimReconciler's "non-terminal" filter:
 *  `claimed` and `cancelled` are terminal — the funding note is
 *  either gone (settled → vault.remove) or rotated (cancelled →
 *  fresh-salt note replaces the original). */
const OPEN_STATUSES: ReadonlySet<OrderRecord["status"]> = new Set([
  "matching",
  "claimable",
]);

/** Pure classifier — no React, no side effects. Linear scan over
 *  `orders` per call. Per-note callers that loop over a large
 *  vault should build a single status map (one O(orders) pass to
 *  bucket open-orders by `noteId` / `changeCommitment`, then O(1)
 *  per note); the panel does this through `aggregateBySymbol`
 *  and a precomputed `Map<noteId, NoteStatusInfo>` in
 *  MyPositionPanel. Calling this directly is fine for one-off
 *  lookups (cancel modal, etc.). */
export function deriveNoteStatus(
  note: VaultNote,
  orders: readonly OrderRecord[],
): NoteStatusInfo {
  if (note.leafIndex < 0) {
    // Try to identify which open order this pending residual came
    // from by matching its commitment against `changeCommitment`
    // stored on the OrderRecord at submit time. Only open orders
    // qualify — a claimed order's change has already been
    // reconciled (leafIndex set) so it wouldn't be pending; a
    // cancelled order's change was cleaned up by CancelOrderModal.
    for (const o of orders) {
      if (
        o.changeCommitment !== undefined &&
        o.changeCommitment === note.commitment &&
        OPEN_STATUSES.has(o.status)
      ) {
        return { status: "pending", pendingFromOrder: o };
      }
    }
    return { status: "pending" };
  }
  for (const o of orders) {
    if (o.noteId === note.id && OPEN_STATUSES.has(o.status)) {
      return { status: "locked", lockedByOrder: o };
    }
  }
  return { status: "available" };
}

/** Per-symbol aggregation for the panel header: how much sits in
 *  each of the three buckets. Built in one pass over notes so the
 *  panel doesn't recompute per status. Amounts are display-string
 *  totals — naive `Number` parsing is acceptable here because the
 *  panel only shows the running total; precise BigInt math runs
 *  on the spend / withdraw paths. */
export interface SymbolBuckets {
  symbol: string;
  available: number;
  locked: number;
  pending: number;
}

export function aggregateBySymbol(
  notes: readonly VaultNote[],
  orders: readonly OrderRecord[],
): SymbolBuckets[] {
  const by = new Map<string, SymbolBuckets>();
  for (const n of notes) {
    const amt = Number(n.amount.replace(/,/g, ""));
    if (!Number.isFinite(amt)) continue;
    const { status } = deriveNoteStatus(n, orders);
    let row = by.get(n.symbol);
    if (!row) {
      row = { symbol: n.symbol, available: 0, locked: 0, pending: 0 };
      by.set(n.symbol, row);
    }
    row[status] += amt;
  }
  return Array.from(by.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}
