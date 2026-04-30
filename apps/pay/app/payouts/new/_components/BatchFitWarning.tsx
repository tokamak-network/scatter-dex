"use client";

import { describeBatchFitError, type PerBatchPick } from "../../../_lib/sourceNotes";

/** Multi-batch picker pre-flight: warn at Funds step rather than
 *  throwing at sign time. The shortfall check (sum-of-totals) is
 *  rendered separately; this is the per-batch fit check (each batch
 *  needs one confirmed note ≥ its totalAmount). Returns null when
 *  there's nothing to warn about so the caller can render it
 *  unconditionally. */
export function BatchFitWarning({
  batchCount,
  multiBatchFit,
  shortfallRaw,
}: {
  batchCount: number;
  multiBatchFit: PerBatchPick | null;
  shortfallRaw: bigint;
}) {
  if (
    !(
      batchCount > 1 &&
      multiBatchFit &&
      !multiBatchFit.covered &&
      multiBatchFit.reason &&
      shortfallRaw === 0n
    )
  ) {
    return null;
  }
  // Render the same copy `doSubmit` would throw with — single source
  // via `describeBatchFitError` so the warning here and the thrown
  // error can't drift.
  const { title, body } = describeBatchFitError(multiBatchFit.reason, batchCount);
  return (
    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
      <div className="mb-1 font-semibold">{title}</div>
      <p>{body}</p>
    </div>
  );
}
