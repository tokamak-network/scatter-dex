import { type CircuitTier, TIERS } from "../constants";
import { deriveClaimSecret, toBytes32Hex } from "../commitment";
import { buildClaimsTree } from "./claim";

/** One recipient line for deep recovery, in leaf order. The operator
 *  supplies these (they created the payout); amounts are token-raw. */
export interface DeepRecoverRecipient {
  recipient: string;
  amount: bigint;
}

export interface DeepRecoverArgs {
  /** Per-payout seed — re-derived from the wallet via `claimSeedFromKey`. */
  seed: bigint;
  /** Recipients in their original leaf order (index matters: it feeds
   *  both the tree position and the secret derivation). */
  recipients: DeepRecoverRecipient[];
  token: string;
  /** Claims-tree capacity the settle used (16 | 64 | 128). */
  tierCap: number;
  /** The on-chain-registered root to match against (0x bytes32). */
  targetClaimsRoot: string;
  /** Inclusive unix-second search window for the one unknown field,
   *  releaseTime (= claimFrom). */
  startSec: number;
  endSec: number;
  /** Search granularity in seconds (default 1). */
  stepSec?: number;
  /** Safety cap on candidates so a fat-fingered window can't spin
   *  forever. Default 200k (~2 days at 1s). Exceeding it throws. */
  maxCandidates?: number;
  /** Progress callback (scanned, total) for a UI bar. */
  onProgress?: (scanned: number, total: number) => void;
  /** Abort signal so the UI can cancel a long scan. */
  signal?: AbortSignal;
}

export interface DeepRecoverClaim {
  recipient: string;
  token: string;
  amount: bigint;
  releaseTime: bigint;
  secret: bigint;
}

export interface DeepRecoverResult {
  releaseTime: bigint;
  /** Reconstructed claims (with derived secrets) for the matched root —
   *  feed these to the package rebuilder. */
  claims: DeepRecoverClaim[];
}

/** Recover the one fuzzy field — `releaseTime` — of a payout whose
 *  claim links were lost, by reconstructing the claims tree for each
 *  candidate timestamp and matching it against the on-chain root.
 *
 *  Everything else is known: the seed is re-derivable from the wallet,
 *  and the operator supplies recipients + amounts + order. releaseTime
 *  is run-wide (one value for the whole payout), so it's a single scalar
 *  to scan, with the on-chain `claimsRoot` as an exact-match oracle.
 *  Returns the matched releaseTime + reconstructed claims, or `null` if
 *  no candidate in the window reproduces the target root. */
export async function deepRecoverReleaseTime(
  args: DeepRecoverArgs,
): Promise<DeepRecoverResult | null> {
  const { seed, recipients, token, targetClaimsRoot, startSec, endSec } = args;
  const stepSec = args.stepSec ?? 1;
  const maxCandidates = args.maxCandidates ?? 200_000;

  if (recipients.length === 0) throw new Error("deepRecover: no recipients");
  if (stepSec <= 0) throw new Error("deepRecover: stepSec must be positive");
  if (endSec < startSec) throw new Error("deepRecover: endSec < startSec");
  const tier: CircuitTier | undefined = TIERS.find((t) => t.cap === args.tierCap);
  if (!tier) throw new Error(`deepRecover: unsupported tierCap ${args.tierCap}`);
  if (recipients.length > tier.cap) {
    throw new Error(`deepRecover: ${recipients.length} recipients exceed tier cap ${tier.cap}`);
  }

  const total = Math.floor((endSec - startSec) / stepSec) + 1;
  if (total > maxCandidates) {
    throw new Error(
      `deepRecover: ${total} candidates exceed the ${maxCandidates} cap — narrow the releaseTime window or widen the step.`,
    );
  }
  const target = targetClaimsRoot.toLowerCase();

  let scanned = 0;
  for (let t = startSec; t <= endSec; t += stepSec) {
    if (args.signal?.aborted) throw new Error("deepRecover: aborted");
    const releaseTime = BigInt(t);
    const claims: DeepRecoverClaim[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i]!;
      const secret = await deriveClaimSecret(seed, r.recipient, token, r.amount, releaseTime, i);
      claims.push({ recipient: r.recipient, token, amount: r.amount, releaseTime, secret });
    }
    const { root } = await buildClaimsTree(claims, tier);
    scanned += 1;
    args.onProgress?.(scanned, total);
    if (toBytes32Hex(root).toLowerCase() === target) {
      return { releaseTime, claims };
    }
  }
  return null;
}
