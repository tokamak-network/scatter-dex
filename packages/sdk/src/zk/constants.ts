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

/** Maximum number of claim leaves per side in a single settlement. */
export const MAX_CLAIMS_PER_SIDE = 16;

/** Depth of the per-settlement claims Merkle tree (2^4 = 16 leaves). */
export const CLAIMS_TREE_DEPTH = 4;
