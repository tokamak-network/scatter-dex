import type { ClaimPackage } from "@zkscatter/sdk/notes";
import { encodeClaimPackage } from "@zkscatter/sdk/notes";
import type { RecipientRow, RunRecord } from "@zkscatter/sdk/storage";
import { formatRecipientCsvRow } from "./format";

const ZERO_TX = "0x" + "0".repeat(64);

export interface PartialRunStats {
  /** True for real-settled records (non-zero tx hash) where some
   *  recipients got a `claimPackage` and some didn't — the state
   *  PR #567's mid-loop catch leaves behind. */
  partial: boolean;
  /** Recipients whose `claimPackage` is missing, in input order so
   *  positional alignment with `claimPackages` from a resume settle
   *  stays stable. */
  unsettled: RecipientRow[];
}

/** Single-pass scan returning both the partial flag and the unsettled
 *  recipient list. Callers that only want one of the two should still
 *  prefer this over running a separate filter — recipients can be in
 *  the hundreds and the dashboard renders the header on every state
 *  change. */
export function partialRunStats(record: RunRecord): PartialRunStats {
  const isReal = record.txHash && record.txHash !== ZERO_TX;
  const unsettled: RecipientRow[] = [];
  let withPkg = 0;
  for (const r of record.recipients) {
    if (r.claimPackage) withPkg++;
    else unsettled.push(r);
  }
  const partial = !!isReal && withPkg > 0 && unsettled.length > 0;
  return { partial, unsettled: partial ? unsettled : [] };
}

export function recipientsToCsv(rows: readonly RecipientRow[]): string {
  return rows.map((r) => formatRecipientCsvRow(r.name, r.address, r.amount)).join("\n");
}

export interface MergeResumeArgs {
  existing: RunRecord;
  /** New claim packages aligned positionally with the unsettled-row
   *  list the wizard prefilled — i.e. `partialRunStats(existing).unsettled[i]`
   *  receives `newPackages[i]`. Mid-loop failures truncate this; rows
   *  past the truncation point stay missing on the merged record so
   *  a follow-up resume picks them up. */
  newPackages: readonly ClaimPackage[];
  txHash: string;
  settledAt: number;
}

/** Merge the new claim packages back onto the original `RunRecord`.
 *  Already-settled rows are left untouched so a stale payload can't
 *  overwrite earlier successful packages. `txHash` and `settledAt`
 *  advance to the most recent batch — RunRecord stores a single tx
 *  hash slot today (same compromise as the original multi-batch
 *  loop). */
export function mergeResumedClaimPackages(args: MergeResumeArgs): RunRecord {
  const { existing, newPackages, txHash, settledAt } = args;
  const { unsettled } = partialRunStats(existing);
  const byRowIndex = new Map<number, ClaimPackage>();
  newPackages.forEach((pkg, i) => {
    const target = unsettled[i];
    if (target) byRowIndex.set(target.rowIndex, pkg);
  });
  const recipients: RecipientRow[] = existing.recipients.map((r) => {
    if (r.claimPackage) return r;
    const pkg = byRowIndex.get(r.rowIndex);
    return pkg ? { ...r, claimPackage: encodeClaimPackage(pkg) } : r;
  });
  return { ...existing, recipients, txHash, settledAt };
}
