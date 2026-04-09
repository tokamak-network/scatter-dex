/**
 * Shared Poseidon domain-separation tags.
 *
 * Mirrors the canonical definitions in `circuits/tags.circom`. Every
 * Poseidon-based commitment, nullifier, or bound hash prepends one of
 * these tags as its first input so the preimage spaces are disjoint.
 *
 * **WARNING**: any change to these values is a *consensus break* and
 * must be made in lock-step with:
 *   - circuits/tags.circom
 *   - zk-relayer/src/core/tags.ts
 *
 * [issue #128] TAG_COMMITMENT_V2 was added in the commitment-pubkey
 * binding refactor (see circuits/tags.circom for the threat-model
 * background). The v1 format `Poseidon(secret, token, amount, salt)`
 * is gone — this is a clean cutover with no legacy fallback.
 */

export const TAG_ESCROW_NULL = 0n;
export const TAG_NONCE_NULL = 1n;
export const TAG_CLAIM_NULL = 2n;
export const TAG_COMMITMENT_V2 = 3n;
