/** Fee math for scatter (pay) orders. Used by both the wizard's
 *  global breakdown (UI total across all batches) and the per-batch
 *  proof builder so the two never drift. */

export const BPS_DENOMINATOR = 10_000n;

export interface BatchFeeBreakdown {
  /** `lockedAmount × maxFeeBps / 10000` — the operator's bps cut. */
  serviceFeeRaw: bigint;
  /** `recipientCount × claimFeePerRecipientRaw` — fixed per-claim
   *  reserve the relayer pre-collects to cover claim-gasless gas. */
  claimReserveRaw: bigint;
  /** `serviceFeeRaw + claimReserveRaw` — exact amount the relayer
   *  will charge (no bps round-up). */
  feeRaw: bigint;
  /** `lockedAmount + feeRaw` — what the proof commits to as
   *  sellAmount; depositor escrows this. */
  sellAmount: bigint;
  /** Tightest bps cap covering `feeRaw` against `sellAmount`. The
   *  on-chain check `fee × 10000 ≤ sellAmount × maxFee` truncates to
   *  integer bps, so the cap must be a ceiling. The relayer still
   *  charges `feeRaw` exactly — this is a safety bound, not the
   *  payout multiplier. Falls back to `maxFeeBps` when `sellAmount`
   *  is zero (degenerate UI state — form's other guards prevent
   *  submit). */
  effectiveMaxFeeBps: number;
}

export interface BatchFeeInput {
  /** Sum of recipient payout amounts in this batch (token-raw). */
  lockedAmount: bigint;
  /** Number of recipients in this batch. */
  recipientCount: number;
  /** Operator-chosen service bps. Must be in [0, 10000]. */
  maxFeeBps: number;
  /** Platform per-recipient claim reserve in token-raw. Zero when
   *  the relayer hasn't published a policy for the token. */
  claimFeePerRecipientRaw: bigint;
}

export function computeBatchFee(input: BatchFeeInput): BatchFeeBreakdown {
  const { lockedAmount, recipientCount, maxFeeBps, claimFeePerRecipientRaw } = input;
  const serviceFeeRaw = (lockedAmount * BigInt(maxFeeBps)) / BPS_DENOMINATOR;
  const claimReserveRaw = BigInt(recipientCount) * claimFeePerRecipientRaw;
  const feeRaw = serviceFeeRaw + claimReserveRaw;
  const sellAmount = lockedAmount + feeRaw;
  const effectiveMaxFeeBps =
    sellAmount > 0n
      ? Number((feeRaw * BPS_DENOMINATOR + sellAmount - 1n) / sellAmount)
      : maxFeeBps;
  return { serviceFeeRaw, claimReserveRaw, feeRaw, sellAmount, effectiveMaxFeeBps };
}
