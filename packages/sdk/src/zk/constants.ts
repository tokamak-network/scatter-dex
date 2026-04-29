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
 *  **Migration status:** today only `generateAuthorizeProof` /
 *  `splitPayout` are wired against {@link MAX_CLAIMS_PER_SIDE} —
 *  those callers still resolve the tier-16 cap implicitly through
 *  the deprecated re-export. As tier 64 / 128 ship, the proof
 *  helpers will be re-shaped to take a {@link CircuitTier} so the
 *  cap is no longer derived from a module-level constant. */
export interface CircuitTier {
  /** Max claims per side (= 2^claimsTreeDepth). Doubles as the
   *  on-chain verifier registry key on PrivateSettlement. */
  readonly cap: 16 | 64 | 128;
  /** Depth of the per-settlement claims Merkle tree (log2 of `cap`). */
  readonly claimsTreeDepth: 4 | 6 | 7;
}

/** Tier 16 — the only circuit live today. Claims tree depth 4 → 16
 *  leaves, ~15K constraints, ptau pot15 / pot16. */
export const TIER_16: CircuitTier = { cap: 16, claimsTreeDepth: 4 };

/** Tier 64 — planned. Depth 6 → 64 leaves. ~60K constraints. ptau
 *  pot17 covers it. Verifier registers via PrivateSettlement
 *  `setAuthorizeVerifier(64, addr)` once the ceremony ships. */
export const TIER_64: CircuitTier = { cap: 64, claimsTreeDepth: 6 };

/** Tier 128 — planned. Depth 7 → 128 leaves. ~120K constraints.
 *  Heaviest prove time, mobile-borderline. ptau pot18 covers it. */
export const TIER_128: CircuitTier = { cap: 128, claimsTreeDepth: 7 };

/** Public registry of every tier the SDK knows about, ordered by
 *  capacity. Use {@link pickTier} to select one — direct indexing is
 *  fine when the tier is fixed (e.g. tests). */
export const TIERS: readonly CircuitTier[] = [TIER_16, TIER_64, TIER_128];

/** Tiers that have a live verifier today. Production code should
 *  validate against this list before submitting; everything outside
 *  it will revert on-chain with `TierNotConfigured(tier)`. */
export const ACTIVE_TIERS: readonly CircuitTier[] = [TIER_16];

/** Pick the smallest tier that fits `recipientCount`. Returns the
 *  matching {@link CircuitTier} or throws when no tier covers the
 *  request — capping the upper bound is intentional, the on-chain
 *  cap mirrors it.
 *
 *  Callers should pad the actual claims array up to `tier.cap` with
 *  dummy entries (see {@link padClaims}) to keep per-tier batches
 *  visually identical and protect the per-tier anonymity set. */
export function pickTier(recipientCount: number): CircuitTier {
  if (!Number.isInteger(recipientCount) || recipientCount <= 0) {
    throw new Error(
      `pickTier: recipientCount must be a positive integer (got ${recipientCount})`,
    );
  }
  for (const tier of TIERS) {
    if (recipientCount <= tier.cap) return tier;
  }
  throw new Error(
    `pickTier: ${recipientCount} recipients exceeds the largest tier (${TIERS[TIERS.length - 1].cap}). ` +
      `Split the payout across multiple runs.`,
  );
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
