import type { StoredNote } from "@zkscatter/sdk/notes";
import { tokenBigIntToAddress } from "./format";

/** Per-token vault summary. `availableRaw` only counts notes the
 *  picker can actually spend (`leafIndex >= 0`); `pendingRaw` is
 *  what's deposited but the leafIndex reconciler hasn't observed
 *  yet. Splitting them lets the Funds step explain "balance looks
 *  enough but can't sign yet — wait" instead of a confusing
 *  shortfall=0 + deposit-blocked state. Mirrors the same
 *  reconciliation gate `pickPerBatchNotes` enforces. */
export function summarizeBalance(
  notes: readonly StoredNote[],
  tokenAddress: string,
): { availableRaw: bigint; pendingRaw: bigint } {
  const tokenLower = tokenAddress.toLowerCase();
  let availableRaw = 0n;
  let pendingRaw = 0n;
  for (const n of notes) {
    if (tokenBigIntToAddress(n.note.token) !== tokenLower) continue;
    if (n.leafIndex >= 0) availableRaw += n.note.amount;
    else pendingRaw += n.note.amount;
  }
  return { availableRaw, pendingRaw };
}

/** A note picked to fund a run, with the partial-spend amount the
 *  settlement will charge against it. The last note in the picked
 *  list usually has `amount > spend` — the leftover is returned as
 *  change via `AuthorizeProofInput.newSalt`. */
export interface PickedNote {
  note: StoredNote;
  /** Amount of `note.amount` charged toward the run. ≤ note.amount. */
  spend: bigint;
}

export interface SourceNotesPick {
  /** Notes picked, in spend order. Empty when the available balance
   *  is below the requested total. */
  notes: PickedNote[];
  /** Total `spend` summed across `notes`. Equals the requested total
   *  when coverage succeeded, else 0. */
  coveredRaw: bigint;
  /** Sum of `note.amount` across picked notes. Always
   *  `>= coveredRaw`. The difference is the change UTXO. */
  pickedRaw: bigint;
  /** `pickedRaw - coveredRaw` — the new change note's amount. */
  changeRaw: bigint;
  /** `true` when the pick fully covers the requested total. */
  covered: boolean;
}

/** Largest-first greedy auto-pick. Filters `notes` by token, sorts
 *  desc by amount, takes notes until the running sum ≥ `totalRaw`.
 *  The final note becomes a partial-spend (its leftover is the
 *  change). When `availableSum < totalRaw`, returns
 *  `{ notes: [], covered: false }`.
 *
 *  Pure helper. The caller owns the actual proof building — this
 *  just decides *which* notes to spend. */
/** Build a {@link SourceNotesPick} from a manually-selected set of
 *  vault note ids. Skips pending notes (`leafIndex < 0`) so a stray
 *  selection on a confirming deposit can't poison the settle path —
 *  the panel disables those checkboxes anyway, this is the
 *  defence-in-depth check. Returns `covered=false` when the
 *  selection's total amount doesn't cover `totalRaw`. */
export function pickFromSelectedNotes(
  notes: readonly StoredNote[],
  selectedIds: ReadonlySet<string>,
  tokenAddress: string,
  totalRaw: bigint,
): SourceNotesPick {
  const empty: SourceNotesPick = {
    notes: [],
    coveredRaw: 0n,
    pickedRaw: 0n,
    changeRaw: 0n,
    covered: false,
  };
  if (totalRaw <= 0n || selectedIds.size === 0) return empty;
  const tokenLower = tokenAddress.toLowerCase();
  const eligible = notes
    .filter(
      (n) =>
        selectedIds.has(n.id) &&
        n.leafIndex >= 0 &&
        tokenBigIntToAddress(n.note.token) === tokenLower,
    )
    // Spend largest first so the partial-spend lands on the smallest
    // selected note, minimising the change UTXO.
    .slice()
    .sort((a, b) =>
      a.note.amount === b.note.amount
        ? 0
        : a.note.amount < b.note.amount
          ? 1
          : -1,
    );
  const picked: PickedNote[] = [];
  let pickedRaw = 0n;
  for (const n of eligible) {
    if (pickedRaw >= totalRaw) break;
    const remaining = totalRaw - pickedRaw;
    const spend = n.note.amount <= remaining ? n.note.amount : remaining;
    picked.push({ note: n, spend });
    pickedRaw += n.note.amount;
  }
  if (pickedRaw < totalRaw) return empty;
  return {
    notes: picked,
    coveredRaw: totalRaw,
    pickedRaw,
    changeRaw: pickedRaw - totalRaw,
    covered: true,
  };
}

export function autoPickSourceNotes(
  notes: readonly StoredNote[],
  tokenAddress: string,
  totalRaw: bigint,
): SourceNotesPick {
  const empty: SourceNotesPick = {
    notes: [],
    coveredRaw: 0n,
    pickedRaw: 0n,
    changeRaw: 0n,
    covered: false,
  };
  if (totalRaw <= 0n) return empty;

  // Normalize token-address case so callers don't have to.
  // `tokenBigIntToAddress` returns lowercase, so a checksummed
  // input would silently match nothing without this.
  const tokenLower = tokenAddress.toLowerCase();
  const filtered = notes
    .filter((n) => tokenBigIntToAddress(n.note.token) === tokenLower)
    .slice()
    .sort((a, b) => (a.note.amount === b.note.amount ? 0 : a.note.amount < b.note.amount ? 1 : -1));

  const picked: PickedNote[] = [];
  let pickedRaw = 0n;
  for (const n of filtered) {
    if (pickedRaw >= totalRaw) break;
    const remaining = totalRaw - pickedRaw;
    const spend = n.note.amount <= remaining ? n.note.amount : remaining;
    picked.push({ note: n, spend });
    pickedRaw += n.note.amount;
  }
  if (pickedRaw < totalRaw) return empty;

  return {
    notes: picked,
    coveredRaw: totalRaw,
    pickedRaw,
    changeRaw: pickedRaw - totalRaw,
    covered: true,
  };
}

export interface BatchPick {
  note: StoredNote;
  /** Equal to the paired batch's `totalAmount`. realSettle uses this
   *  as `sellAmount`; the residual `note.amount - spend` becomes the
   *  change UTXO returned by that settle's proof. */
  spend: bigint;
}

export interface PerBatchPick {
  /** Aligned 1:1 with the input `batches`. \`byBatch[i]\` is the
   *  source note paired with batch[i]. Empty when not covered. */
  byBatch: BatchPick[];
  /** Combined leftover across every paired note. */
  changeRaw: bigint;
  /** True when every batch could be matched against an eligible
   *  note ≥ batch.totalAmount. */
  covered: boolean;
  /** When covered=false, names the failure mode so the wizard can
   *  surface a specific error rather than a generic "no funds". */
  reason?:
    | "no-eligible-notes"
    | "insufficient-note-count"
    | "smallest-batch-uncovered";
}

/** Multi-batch picker: pair every batch with its own source note so
 *  multi-recipient runs can settle as N sequential
 *  `scatterDirectAuth` calls (one per batch). Strategy: sort batches
 *  desc by totalAmount, sort eligible notes desc by amount, pair
 *  i-th largest batch with i-th largest note. The fit succeeds only
 *  when the smallest paired note still covers its smallest paired
 *  batch — otherwise the user has at least one batch that doesn't
 *  fit any single note. Notes whose `leafIndex < 0` are excluded
 *  because the spend path's authorize proof needs the on-chain
 *  index reconciled. */
export function pickPerBatchNotes(
  notes: readonly StoredNote[],
  batches: readonly { totalAmount: bigint }[],
  tokenAddress: string,
  /** When provided + non-empty, restrict the eligible pool to notes
   *  whose id is in the set. This keeps the actual settle path
   *  honoring the operator's manual selection — without it, the
   *  funds-step preview (which respects `selectedIds`) and the
   *  on-chain settle (which used to ignore them) could disagree on
   *  *which* note got spent and where the change UTXO landed. */
  selectedIds?: ReadonlySet<string>,
): PerBatchPick {
  if (batches.length === 0) {
    return { byBatch: [], changeRaw: 0n, covered: true };
  }
  const tokenLower = tokenAddress.toLowerCase();
  const useSelection = !!selectedIds && selectedIds.size > 0;
  const eligible = notes
    .filter((n) => tokenBigIntToAddress(n.note.token) === tokenLower)
    .filter((n) => n.leafIndex >= 0)
    .filter((n) => (useSelection ? selectedIds!.has(n.id) : true))
    .slice()
    .sort((a, b) =>
      a.note.amount === b.note.amount ? 0 : a.note.amount < b.note.amount ? 1 : -1,
    );
  if (eligible.length === 0) {
    return { byBatch: [], changeRaw: 0n, covered: false, reason: "no-eligible-notes" };
  }
  if (eligible.length < batches.length) {
    return {
      byBatch: [],
      changeRaw: 0n,
      covered: false,
      reason: "insufficient-note-count",
    };
  }
  const sortedBatches = batches
    .map((b, originalIndex) => ({ totalAmount: b.totalAmount, originalIndex }))
    .sort((a, b) =>
      a.totalAmount === b.totalAmount ? 0 : a.totalAmount < b.totalAmount ? 1 : -1,
    );
  const byBatch: BatchPick[] = new Array(batches.length);
  let changeRaw = 0n;
  for (let i = 0; i < sortedBatches.length; i++) {
    const b = sortedBatches[i]!;
    const note = eligible[i]!;
    if (note.note.amount < b.totalAmount) {
      return {
        byBatch: [],
        changeRaw: 0n,
        covered: false,
        reason: "smallest-batch-uncovered",
      };
    }
    byBatch[b.originalIndex] = { note, spend: b.totalAmount };
    changeRaw += note.note.amount - b.totalAmount;
  }
  return { byBatch, changeRaw, covered: true };
}

/** Map a `PerBatchPick.reason` to a user-facing title + body. Used
 *  both inside `doSubmit` (as thrown error message bodies) and the
 *  Funds-step pre-flight banner — single source so the two surfaces
 *  can't drift on copy. */
export function describeBatchFitError(
  reason: NonNullable<PerBatchPick["reason"]>,
  batchCount: number,
): { title: string; body: string } {
  switch (reason) {
    case "no-eligible-notes":
      return {
        title: "No reconciled notes for this token",
        body:
          "Recently-deposited notes need one block to confirm before " +
          "they're spendable. Wait for the next block or top up.",
      };
    case "insufficient-note-count":
      return {
        title: `${batchCount} batches need ${batchCount} source notes`,
        body:
          `Your balance covers the total, but the run splits into ${batchCount} ` +
          "settlement transactions and you have fewer confirmed notes than " +
          "batches. Each batch consumes one note — top up so every batch has " +
          "its own. Change UTXOs from earlier batches don't yet flow into " +
          "later ones.",
      };
    case "smallest-batch-uncovered":
      return {
        title: "Notes don't fit batch-by-batch",
        body:
          "Each batch needs its own note ≥ that batch's total. The picker " +
          "pairs largest-with-largest; one of those pairings came up short. " +
          "Top up so you have at least one large-enough note for every batch " +
          "(not just for the biggest one).",
      };
  }
}
