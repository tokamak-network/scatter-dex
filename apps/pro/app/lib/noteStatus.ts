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
 *  lookups (cancel modal, etc.).
 *
 *  `nowMs` defaults to `Date.now()` so existing call sites stay
 *  source-compatible. Callers that batch-classify a vault should
 *  pass a snapshot so every note in the pass sees the same wall
 *  clock — otherwise two notes pinned by the same order could
 *  classify differently if the wall clock crosses the expiry mid
 *  iteration. */
export function deriveNoteStatus(
  note: VaultNote,
  orders: readonly OrderRecord[],
  nowMs: number = Date.now(),
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
        OPEN_STATUSES.has(o.status) &&
        // Same matching-only expiry shortcut as the locked branch.
        // A claimable order's residual is still inbound from chain;
        // expiry on the original authorize proof doesn't apply.
        !(o.status === "matching" && isOrderExpired(o, nowMs))
      ) {
        return { status: "pending", pendingFromOrder: o };
      }
    }
    return { status: "pending" };
  }
  for (const o of orders) {
    if (o.noteId === note.id && OPEN_STATUSES.has(o.status)) {
      // Expired *matching* orders can't re-claim the funding note:
      // SettleVerifyLib reverts with OrderExpired before the
      // nullifier ever lands (SettleVerifyLib.sol:147), so a stale
      // authorize proof literally can't outrun a fresh order using
      // the same commitment. Treat the note as available so the
      // OrderModal can pick it as collateral immediately — no
      // user-driven cancel required.
      //
      // The same expiry check is NOT applied to `claimable` orders.
      // Claimable means the cross-side fill already settled and the
      // funds are mid-flight to a recipient; the original authorize
      // proof's expiry no longer matters. The lock here represents
      // the on-chain encumbrance from the matched fill, not the
      // pre-match authorize binding.
      if (o.status === "matching" && isOrderExpired(o, nowMs)) continue;
      return { status: "locked", lockedByOrder: o };
    }
  }
  return { status: "available" };
}

/** Mirror of `apps/pro/app/orders/page.tsx`'s isExpired so the
 *  escrow lock check and the orders-page Expired bucket can't
 *  disagree on a single source of truth. Orders without an
 *  `expiry` field (pre-PR records) are never expired. */
function isOrderExpired(o: OrderRecord, nowMs: number): boolean {
  if (o.expiry === undefined) return false;
  return Number(o.expiry) * 1000 <= nowMs;
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
  nowMs: number = Date.now(),
): SymbolBuckets[] {
  const by = new Map<string, SymbolBuckets>();
  for (const n of notes) {
    const amt = Number(n.amount.replace(/,/g, ""));
    if (!Number.isFinite(amt)) continue;
    // Pass the snapshot `nowMs` so this aggregation and any
    // per-note `deriveNoteStatus` call in the same render frame
    // agree on which orders are expired.
    const { status } = deriveNoteStatus(n, orders, nowMs);
    let row = by.get(n.symbol);
    if (!row) {
      row = { symbol: n.symbol, available: 0, locked: 0, pending: 0 };
      by.set(n.symbol, row);
    }
    row[status] += amt;
  }
  return Array.from(by.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}
