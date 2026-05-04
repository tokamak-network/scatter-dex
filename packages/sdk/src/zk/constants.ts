/** Shared ZK circuit dimensions.
 *
 *  These values must stay in sync with the compiled circuits:
 *    - circuits/authorize.circom (commitTreeDepth, maxClaimsPerSide,
 *      claimsTreeDepth)
 *    - circuits/claim.circom    (claimsTreeDepth)
 *    - contracts/src/zk/IncrementalMerkleTree.sol (levels)
 *
 *  Changing any of these requires recompiling the circuits and
 *  re-running the trusted setup ceremony — i.e. it's a consensus
 *  break, not a runtime tweak. */

/** Depth of the on-chain commitment Merkle tree (2^20 ≈ 1M leaves). */
export const COMMIT_TREE_DEPTH = 20;

/** Tier descriptor for an authorize.circom variant. The same Pay/Pro
 *  flow can run against any tier — the only differences are the
 *  compiled wasm/zkey assets, the on-chain verifier address, and how
 *  many claims fit per settlement. The 15 Groth16 public signals are
 *  shared across tiers (claimsRoot already aggregates the variable-
 *  length claims set inside the circuit).
 *
 *  All three protocol tiers (16 / 64 / 128) are live; the proof
 *  helpers (`generateAuthorizeProof`, `generateClaimProof`,
 *  `splitPayout`) take a {@link CircuitTier} parameter and default
 *  to TIER_16 only for legacy callers. {@link MAX_CLAIMS_PER_SIDE}
 *  stays as a deprecated re-export for the same reason. */
export interface CircuitTier {
  /** Max claims per side (= 2^claimsTreeDepth). Doubles as the
   *  on-chain verifier registry key on PrivateSettlement. */
  readonly cap: 16 | 64 | 128;
  /** Depth of the per-settlement claims Merkle tree (log2 of `cap`). */
  readonly claimsTreeDepth: 4 | 6 | 7;
}

/** Tier 16 — depth 4 → 16 leaves, ~23K authorize constraints, ptau
 *  pot15. The default + smallest tier; what every Pay run uses
 *  for ≤ 16 recipients. */
export const TIER_16: CircuitTier = { cap: 16, claimsTreeDepth: 4 };

/** Tier 64 — depth 6 → 64 leaves, ~56K authorize constraints, ptau
 *  pot16. Picked by `pickActiveTier` for runs of 17–64 recipients.
 *  Registered on `PrivateSettlement` via `setAuthorizeVerifier(64,
 *  addr)` + `setClaimVerifier(64, addr)`. */
export const TIER_64: CircuitTier = { cap: 64, claimsTreeDepth: 6 };

/** Tier 128 — depth 7 → 128 leaves, ~101K authorize constraints,
 *  ptau pot17. Picked by `pickActiveTier` for runs of 65–128
 *  recipients. Heaviest prove time (~6–12 s on a mid-tier laptop;
 *  mobile-borderline) — Pay's wizard surfaces the trade-off in the
 *  Privacy plan. */
export const TIER_128: CircuitTier = { cap: 128, claimsTreeDepth: 7 };

/** Public registry of every tier the SDK knows about, ordered by
 *  capacity. Use {@link pickTier} to select one — direct indexing is
 *  fine when the tier is fixed (e.g. tests). */
export const TIERS: readonly CircuitTier[] = [TIER_16, TIER_64, TIER_128];

/** Tiers that have a live verifier today. Production code should
 *  validate against this list before submitting; everything outside
 *  it will revert on-chain with `TierNotConfigured(tier)`.
 *
 *  **Ordering invariant**: must stay sorted by `cap` ascending.
 *  {@link pickActiveTier} relies on the order — the first match wins
 *  (smallest tier that covers `n`), and the multi-batch fallback uses
 *  the last entry as the largest available cap. New tiers must be
 *  inserted in sorted position; the assertion below enforces it at
 *  module load to keep silent ordering bugs from changing tier
 *  selection. */
export const ACTIVE_TIERS: readonly CircuitTier[] = [TIER_16, TIER_64, TIER_128];

for (let i = 1; i < ACTIVE_TIERS.length; i++) {
  if (ACTIVE_TIERS[i]!.cap <= ACTIVE_TIERS[i - 1]!.cap) {
    throw new Error(
      `ACTIVE_TIERS must be sorted by cap ascending: index ${i} (cap=${ACTIVE_TIERS[i]!.cap}) does not exceed index ${i - 1} (cap=${ACTIVE_TIERS[i - 1]!.cap})`,
    );
  }
}

/** Pick the smallest tier that fits `recipientCount`. Returns the
 *  matching {@link CircuitTier} or throws when no tier covers the
 *  request — capping the upper bound is intentional, the on-chain
 *  cap mirrors it.
 *
 *  Callers should pad the actual claims array up to `tier.cap` with
 *  dummy entries (see {@link padClaims}) to keep per-tier batches
 *  visually identical and protect the per-tier anonymity set.
 *
 *  This is the **theoretical** picker — it considers every tier the
 *  protocol defines, including ones whose verifier is not yet
 *  deployed. Production callers want {@link pickActiveTier}, which
 *  filters to {@link ACTIVE_TIERS} and falls back to the largest
 *  active tier with multi-batch when no active tier covers the
 *  request. */
export function pickTier(recipientCount: number): CircuitTier {
  validateRecipientCount("pickTier", recipientCount);
  for (const tier of TIERS) {
    if (recipientCount <= tier.cap) return tier;
  }
  throw new Error(
    `pickTier: ${recipientCount} recipients exceeds the largest tier (${TIERS[TIERS.length - 1].cap}). ` +
      `Split the payout across multiple runs.`,
  );
}

/** Pick the smallest **active** tier that fits `recipientCount` —
 *  i.e. one whose verifier is wired on-chain today (see
 *  {@link ACTIVE_TIERS}). When no active tier covers the request, the
 *  largest active tier is returned so the caller can chunk the
 *  recipients into multiple batches of that tier; this is the
 *  multi-batch fallback the Pay app uses while tier 64 / 128 are not
 *  yet live.
 *
 *  Throws when `ACTIVE_TIERS` is empty (a misconfigured deployment).
 *
 *  Use this in production paths that actually generate proofs and
 *  submit on-chain; reserve {@link pickTier} for design-level
 *  reasoning that should ignore deployment status. */
export function pickActiveTier(recipientCount: number): CircuitTier {
  validateRecipientCount("pickActiveTier", recipientCount);
  if (ACTIVE_TIERS.length === 0) {
    throw new Error(
      "pickActiveTier: ACTIVE_TIERS is empty — no authorize verifier is wired",
    );
  }
  for (const tier of ACTIVE_TIERS) {
    if (recipientCount <= tier.cap) return tier;
  }
  // No active tier fits — fall back to the largest active tier so the
  // caller can multi-batch on it. The fallback intentionally does not
  // throw: today (only TIER_16 active) a 17-recipient run still
  // succeeds via two tier-16 batches, and the moment TIER_64 activates
  // that same call returns TIER_64 as a single batch.
  return ACTIVE_TIERS[ACTIVE_TIERS.length - 1]!;
}

function validateRecipientCount(fn: string, n: number): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${fn}: recipientCount must be a positive integer (got ${n})`,
    );
  }
}

/** Pad a claims array up to `tier.cap` by appending the same `dummy`
 *  value in every empty slot. The returned array is a new outer
 *  array (the input is not mutated), but each padded slot **shares
 *  one reference** to `dummy` — pass a frozen / immutable sentinel
 *  when `T` is an object type, or callers will see ghost mutations
 *  across slots. Throws when the input already exceeds the tier
 *  capacity (the caller picked the wrong tier for this list).
 *
 *  Padding is mandatory for anonymity: every tier-N settlement looks
 *  like every other tier-N settlement at the on-chain layer because
 *  the claims tree always carries N leaves. Tight-packing leaks the
 *  recipient count via the calldata size and proof timing. */
export function padClaims<T>(claims: readonly T[], tier: CircuitTier, dummy: T): T[] {
  if (claims.length > tier.cap) {
    throw new Error(
      `padClaims: ${claims.length} claims exceeds tier ${tier.cap} capacity`,
    );
  }
  const padded = claims.slice() as T[];
  while (padded.length < tier.cap) padded.push(dummy);
  return padded;
}

/** Maximum number of claim leaves per side in a single settlement.
 *
 *  @deprecated Use {@link CircuitTier.cap} from a tier picked via
 *  {@link pickTier} instead. Hardcoding the tier-16 cap in callers
 *  blocks the multi-tier rollout. The constant stays as a transitional
 *  re-export of {@link TIER_16.cap} so legacy paths keep compiling. */
export const MAX_CLAIMS_PER_SIDE = TIER_16.cap;

/** Depth of the per-settlement claims Merkle tree (2^4 = 16 leaves).
 *
 *  @deprecated Use {@link CircuitTier.claimsTreeDepth} via
 *  {@link pickTier}. Re-exported as the tier-16 depth during the
 *  multi-tier migration. */
export const CLAIMS_TREE_DEPTH = TIER_16.claimsTreeDepth;
