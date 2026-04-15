/**
 * Shared ZK circuit parameters.
 *
 * These values must stay in sync with the compiled circuits:
 *   - circuits/authorize.circom (commitTreeDepth=20, maxClaimsPerSide=16, claimsTreeDepth=4)
 *   - circuits/claim.circom (claimsTreeDepth=4)
 *   - contracts/src/zk/IncrementalMerkleTree.sol (levels=20)
 *
 * Changing any of these requires recompiling the circuits and
 * re-running the trusted setup ceremony.
 */

/** Depth of the on-chain commitment Merkle tree (2^20 ≈ 1M leaves). */
export const COMMIT_TREE_DEPTH = 20;

/** Maximum number of claim leaves per side in a single settlement. */
export const MAX_CLAIMS_PER_SIDE = 16;

/** Depth of the per-settlement claims Merkle tree (2^4 = 16 leaves). */
export const CLAIMS_TREE_DEPTH = 4;

// Single source of truth for `.wasm` / `.zkey` URLs so a rename in
// `frontend/public/zk/` can't silently desync the prover (which proves
// against ZKEY_PATH) from its worker preload (which prefetches it).
export const CIRCUIT_ASSETS = {
  authorize: { wasm: "/zk/authorize.wasm", zkey: "/zk/authorize_final.zkey" },
  cancel:    { wasm: "/zk/cancel.wasm",    zkey: "/zk/cancel_final.zkey" },
  claim:     { wasm: "/zk/claim.wasm",     zkey: "/zk/claim_final.zkey" },
  deposit:   { wasm: "/zk/deposit.wasm",   zkey: "/zk/deposit_final.zkey" },
  withdraw:  { wasm: "/zk/withdraw.wasm",  zkey: "/zk/withdraw_final.zkey" },
} as const satisfies Record<string, { wasm: string; zkey: string }>;
