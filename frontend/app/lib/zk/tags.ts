/**
 * Shared nullifier domain-separation tags.
 *
 * Mirrors the canonical definitions in `circuits/tags.circom`. Every
 * Poseidon-based nullifier prepends one of these tags as its first input
 * so the three preimage spaces (escrow, nonce, claim) are disjoint.
 *
 * **WARNING**: any change to these values is a *consensus break* and
 * must be made in lock-step with:
 *   - circuits/tags.circom
 *   - zk-relayer/src/core/tags.ts
 *
 * Keeping the constants in one place removes the silent-drift hazard
 * of duplicating them across settle/withdraw/claim and their off-chain
 * helpers.
 */

export const TAG_ESCROW_NULL = 0n;
export const TAG_NONCE_NULL = 1n;
export const TAG_CLAIM_NULL = 2n;
