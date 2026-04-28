import type { StoredNote } from "@zkscatter/sdk/notes";
import { tokenBigIntToAddress } from "./format";

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

  const filtered = notes
    .filter((n) => tokenBigIntToAddress(n.note.token) === tokenAddress)
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
