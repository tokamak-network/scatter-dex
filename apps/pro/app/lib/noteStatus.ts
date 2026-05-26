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
 *    order settles. Either way, not yet spendable.
 *  - `discarded`: leafIndex < 0 AND the matching order that would
 *    have produced this change note has expired. The change
 *    commitment was pre-computed at submit time but the on-chain
 *    settleAuth never ran (the contract reverts post-expiry
 *    before inserting anything), so this commitment will never
 *    appear in the merkle tree. The panel hides these from the
 *    main notes list — they're bookkeeping ghosts of a never-
 *    settled order, not spendable balance. */
export type NoteStatus = "available" | "locked" | "pending" | "discarded";

export interface NoteStatusInfo {
  status: NoteStatus;
  /** When `status === "locked"`, the open order pinning this note.
   *  Undefined for the other states. */
  lockedByOrder?: OrderRecord;
  /** When `status === "pending"` AND the note is the residual of a
   *  not-yet-settled order, the order it came from. Undefined for
   *  ordinary fresh-deposit pendings (no parent order). Surfaced
   *  so the badge can read "Pending change from ord-3" instead of
   *  just "Pending". */
  pendingFromOrder?: OrderRecord;
  /** When `status === "discarded"`, the expired matching order whose
   *  change commitment this note represents — kept so a future
   *  cleanup affordance ("Remove 1 discarded ghost from ord-1") can
   *  explain what it's about to delete. */
  discardedFromOrder?: OrderRecord;
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

/** Index over the `orders` slice used by both `deriveNoteStatus` and
 *  `aggregateBySymbol`. Built once per call so the classifier doesn't
 *  re-scan the whole list per note (O(N×M) → O(N+M)) and so the
 *  expiry check runs once per order instead of once per (order, note)
 *  pair. Only open + non-expired orders are kept; everything filtered
 *  out collapses cleanly to "available". */
interface OrderIndex {
  /** Open + not-yet-expired orders keyed by funding `noteId`. A hit
   *  marks the note as `locked`. */
  byNoteId: Map<string, OrderRecord>;
  /** Open + not-yet-expired orders keyed by `changeCommitment`. A
   *  hit on a `leafIndex < 0` note marks it as `pending`. */
  byChangeCommitment: Map<bigint, OrderRecord>;
  /** Matching-status orders whose expiry has passed, keyed by
   *  `changeCommitment`. A hit marks the pending change note as
   *  `discarded` — it will never settle on-chain so it isn't
   *  spendable nor "still waiting". Separate from the live index
   *  so the locked/pending branches stay O(1) lookups without
   *  re-checking expiry per note. */
  expiredMatchingByChangeCommitment: Map<bigint, OrderRecord>;
}

function buildOrderIndex(
  orders: readonly OrderRecord[],
  nowMs: number,
): OrderIndex {
  const byNoteId = new Map<string, OrderRecord>();
  const byChangeCommitment = new Map<bigint, OrderRecord>();
  const expiredMatchingByChangeCommitment = new Map<bigint, OrderRecord>();
  for (const o of orders) {
    if (!OPEN_STATUSES.has(o.status)) continue;
    // Matching orders past their expiry KEEP pinning their funding
    // note. The on-chain expiry check (SettleVerifyLib.sol:147) only
    // blocks settle — not the authorize binding the commitment is
    // tied to. Reusing the same commitment in a new order would
    // produce two orders that share an escrowNullifier; the next
    // cancelPrivate burns it, leaving the other order as a zombie
    // (status="matching" but pointing at a dead note). The earlier
    // version of this code released the lock here, which is exactly
    // how the ord-1/ord-2 zombie state in the regression that
    // prompted this revert was created. Cancel is the only path
    // that frees the commitment.
    //
    // Still record the order under
    // `expiredMatchingByChangeCommitment` so a `leafIndex < 0`
    // residual surfaces as `discarded` (the change leaf can never
    // land — the parent can't settle past expiry). Don't `continue`:
    // the funding noteId still needs to land in `byNoteId` below
    // so it reads as Locked.
    const isExpiredMatching = o.status === "matching" && isOrderExpired(o, nowMs);
    if (isExpiredMatching && o.changeCommitment !== undefined) {
      expiredMatchingByChangeCommitment.set(o.changeCommitment, o);
    }
    // First-writer-wins on every collision so the index preserves
    // the linear-scan semantics callers had before this refactor
    // (the deriveNoteStatus regression test guards against the
    // last-writer-wins shape Map gives by default).
    if (o.noteId !== undefined && !byNoteId.has(o.noteId)) {
      byNoteId.set(o.noteId, o);
    }
    // The change commitment goes into the OPEN byChangeCommitment
    // only for not-yet-expired orders — expired residuals belong to
    // the discarded index above so classifyAgainstIndex tags them
    // accordingly instead of as still-pending.
    if (
      !isExpiredMatching &&
      o.changeCommitment !== undefined &&
      !byChangeCommitment.has(o.changeCommitment)
    ) {
      byChangeCommitment.set(o.changeCommitment, o);
    }
  }
  return { byNoteId, byChangeCommitment, expiredMatchingByChangeCommitment };
}

/** Pure classifier — no React, no side effects. One-shot calls
 *  (cancel modal, single-row debug) pay an O(orders) index build
 *  on every invocation; batch callers (`aggregateBySymbol`, the
 *  escrow page's statusMap) should reuse one index across all
 *  notes via `classifyAgainstIndex`.
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
  return classifyAgainstIndex(note, buildOrderIndex(orders, nowMs));
}

/** Classify a single note against a pre-built order index. Exposed
 *  for batch callers — `aggregateBySymbol` builds the index once
 *  and reuses it, dropping the classifier from O(N×M) to O(N+M).
 *  Lookups against the three Maps are all O(1).
 *
 *  Decision order:
 *  1. `leafIndex < 0` → pending or discarded depending on whether
 *     the parent order is open vs expired-matching.
 *  2. Reconciled + lives in `byNoteId` → locked.
 *  3. Otherwise → available. */
function classifyAgainstIndex(
  note: VaultNote,
  index: OrderIndex,
): NoteStatusInfo {
  if (note.leafIndex < 0) {
    // Open-order residual — still inbound, treat as pending.
    const fromOpen = index.byChangeCommitment.get(note.commitment);
    if (fromOpen) return { status: "pending", pendingFromOrder: fromOpen };
    // Expired-matching residual — phantom that will never land.
    // Surface as discarded so the panel can hide / clean it up
    // rather than leaving an indefinite "Pending" pill on a note
    // that can't reconcile.
    const fromExpired = index.expiredMatchingByChangeCommitment.get(note.commitment);
    if (fromExpired) {
      return { status: "discarded", discardedFromOrder: fromExpired };
    }
    return { status: "pending" };
  }
  const lockedBy = index.byNoteId.get(note.id);
  if (lockedBy) return { status: "locked", lockedByOrder: lockedBy };
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
 *  each of the three spendable buckets. Built in one pass over
 *  notes so the panel doesn't recompute per status. Amounts are
 *  display-string totals — naive `Number` parsing is acceptable
 *  here because the panel only shows the running total; precise
 *  BigInt math runs on the spend / withdraw paths.
 *
 *  Note: `discarded` notes are deliberately excluded — they're
 *  phantom change commitments from expired matching orders, so
 *  counting them anywhere would inflate the visible balance with
 *  funds that will never actually exist on-chain. */
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
  const index = buildOrderIndex(orders, nowMs);
  const by = new Map<string, SymbolBuckets>();
  for (const n of notes) {
    const amt = Number(n.amount.replace(/,/g, ""));
    if (!Number.isFinite(amt)) continue;
    const { status } = classifyAgainstIndex(n, index);
    // Phantom change notes from expired matching orders never
    // settle — leaving them in the running totals would show the
    // user a balance they can't spend. Skip them entirely; the
    // escrow page handles cleanup affordance separately.
    if (status === "discarded") continue;
    let row = by.get(n.symbol);
    if (!row) {
      row = { symbol: n.symbol, available: 0, locked: 0, pending: 0 };
      by.set(n.symbol, row);
    }
    row[status] += amt;
  }
  return Array.from(by.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}
