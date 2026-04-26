/** Shared Poseidon domain-separation tags.
 *
 *  Mirrors the canonical definitions in `circuits/tags.circom`. Every
 *  Poseidon-based commitment, nullifier, or bound hash prepends one
 *  of these tags as its first input so the preimage spaces are
 *  disjoint.
 *
 *  **CONSENSUS-CRITICAL**: any change to these values must land
 *  in lock-step with:
 *    - `circuits/tags.circom`
 *    - `zk-relayer/src/core/tags.ts`
 *    - `frontend/app/lib/zk/tags.ts` (legacy duplicate, to be removed)
 *  Disagreement here causes proofs to verify against a different
 *  preimage space than the contract expects — silent data loss. */

export const TAG_ESCROW_NULL = 0n;
export const TAG_NONCE_NULL = 1n;
export const TAG_CLAIM_NULL = 2n;
export const TAG_COMMITMENT_V2 = 3n;
