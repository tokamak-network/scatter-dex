import { MAX_CLAIMS_PER_SIDE } from "../constants";
import { randomFieldElement } from "../commitment";
import type { ClaimEntry } from "./authorize";

/** Recipient line for a multi-recipient payout. The token is shared
 *  across the whole payout — see {@link SplitPayoutOpts.token}. */
export interface PayoutRecipient {
  /** Ethereum address (0x-prefixed). */
  recipient: string;
  /** Amount of `opts.token` to send to this recipient. */
  amount: bigint;
  /** Earliest unix-second the recipient can claim. */
  releaseTime: bigint;
  /** Optional pre-computed per-claim secret. When omitted,
   *  {@link splitPayout} draws one from {@link SplitPayoutOpts.generateSecret}
   *  (defaulting to {@link randomFieldElement}). */
  secret?: bigint;
}

export interface SplitPayoutOpts {
  /** Token address that goes into every {@link ClaimEntry.token}.
   *  The protocol enforces `claim.token === buyToken` per used claim,
   *  so callers should pass the same value as their
   *  `AuthorizeProofInput.buyToken`. */
  token: string;
  /** Override the per-claim secret generator. Useful for tests
   *  that need deterministic output. Defaults to
   *  {@link randomFieldElement}. */
  generateSecret?: () => bigint;
}

/** One settle-sized batch of claims. The caller plugs `claims`
 *  into `AuthorizeProofInput.claims` and `totalAmount` into both
 *  `sellAmount` and `buyAmount` (self-pay USDC → USDC pattern).
 *  Each batch needs its own `AuthorizeProofInput` and signature. */
export interface PayoutBatch {
  /** Sum of `amount` across `claims`. */
  totalAmount: bigint;
  /** Up to {@link MAX_CLAIMS_PER_SIDE} fully-formed entries, ready
   *  to pass straight to `generateAuthorizeProof`. */
  claims: ClaimEntry[];
}

/** Chunk a recipient list into batches that fit the protocol's
 *  `MAX_CLAIMS_PER_SIDE` cap (16). Order is preserved — recipient
 *  `i` always lands in batch `floor(i / 16)` — and per-claim
 *  secrets are drawn for any recipient that didn't supply one.
 *
 *  This is a pure helper. The caller still selects which note(s)
 *  to spend per batch, manages the residual change UTXO, and
 *  drives N proofs / N signatures. {@link splitPayout} only
 *  exists so apps don't re-implement chunking + secret-generation
 *  on top of `generateAuthorizeProof`. */
export function splitPayout(
  recipients: PayoutRecipient[],
  opts: SplitPayoutOpts,
): PayoutBatch[] {
  if (recipients.length === 0) {
    throw new Error("splitPayout: at least one recipient is required");
  }
  const generateSecret = opts.generateSecret ?? randomFieldElement;
  const batches: PayoutBatch[] = [];
  for (let i = 0; i < recipients.length; i += MAX_CLAIMS_PER_SIDE) {
    const claims: ClaimEntry[] = [];
    let totalAmount = 0n;
    const end = Math.min(i + MAX_CLAIMS_PER_SIDE, recipients.length);
    for (let j = i; j < end; j++) {
      const r = recipients[j];
      totalAmount += r.amount;
      claims.push({
        secret: r.secret ?? generateSecret(),
        recipient: r.recipient,
        token: opts.token,
        amount: r.amount,
        releaseTime: r.releaseTime,
      });
    }
    batches.push({ totalAmount, claims });
  }
  return batches;
}
