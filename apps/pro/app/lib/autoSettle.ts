import type { RecipientRow } from "./tradeForm";

/** Derivation result for the auto-settle deadline.
 *
 *  - `default`: no claim time set anywhere; settle within the legacy
 *    1 h window (recipients claim immediately on settle).
 *  - `from-claim`: at least one recipient has a future claim time;
 *    settle is targeted at `earliestClaim − 5 min` so the relayer
 *    has time to match + confirm before recipients can claim.
 *  - `too-tight`: the earliest configured claim time is < 6 min
 *    from now (or in the past). The order is unservable as-is —
 *    consumers should gate Sign & submit on this. */
export type AutoSettle =
  | { kind: "default"; expiryMs: number }
  | { kind: "from-claim"; expiryMs: number }
  | { kind: "too-tight"; earliestClaimMs: number };

/** Pure derivation — shared by AutoSettleIndicator (display) and
 *  the workbench submit gate (block submit when `too-tight`). Lives
 *  outside both so the two can't drift. */
export function deriveAutoSettle(
  recipients: readonly Pick<RecipientRow, "releaseAt">[],
  bulkClaimFrom: string,
  nowMs: number,
): AutoSettle {
  // Effective per-row claim time: explicit row value, else the
  // bulk "Claim from (all)" value (typing it without clicking
  // Apply to all still counts — otherwise the default 1 h window
  // could land *after* the user's intended claim time).
  const bulkMs = bulkClaimFrom ? Date.parse(bulkClaimFrom) : NaN;
  const claimMs: number[] = [];
  for (const r of recipients) {
    const own = r.releaseAt ? Date.parse(r.releaseAt) : NaN;
    if (Number.isFinite(own)) claimMs.push(own);
    else if (Number.isFinite(bulkMs)) claimMs.push(bulkMs);
  }
  if (claimMs.length === 0) {
    return { kind: "default", expiryMs: nowMs + 3_600_000 };
  }
  const minClaim = Math.min(...claimMs);
  // 5 min relayer headroom + 1 min user buffer = 6 min minimum
  // between *now* and the earliest claim. A claim in the past
  // (negative delta) also lands here — the indicator surfaces the
  // distinct copy.
  if (minClaim - nowMs < 6 * 60_000) {
    return { kind: "too-tight", earliestClaimMs: minClaim };
  }
  return { kind: "from-claim", expiryMs: minClaim - 5 * 60_000 };
}
