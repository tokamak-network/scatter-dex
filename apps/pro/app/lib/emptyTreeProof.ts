"use client";

import {
  COMMIT_TREE_DEPTH,
  computeCommitment,
  getPoseidonModule,
  poseidonHashWith,
  type CommitmentNote,
  type MerkleProof,
} from "@zkscatter/sdk/zk";

/** Build a Merkle inclusion proof for a single commitment placed
 *  at leaf index 0 of an otherwise-empty tree of `COMMIT_TREE_DEPTH`.
 *
 *  Why not `buildMerkleTree([commitment], depth=20)`: that pads to
 *  `2^20 ≈ 1M` leaves and runs ~1 M Poseidon hashes — multiple
 *  seconds on desktop, much worse on mobile. Since we know the
 *  tree is empty everywhere except index 0, the path is just the
 *  precomputed zero-node values at each level (20 hashes total)
 *  and the root is `hash(commitment, zeros[0]) → hash(_, zeros[1])
 *  → …` (another 20 hashes).
 *
 *  This is enough for **demo** authorize proofs in Phase 3e — the
 *  generated proof carries a valid EdDSA signature against the
 *  user's real key over a self-consistent commitment / nullifier
 *  / Merkle root, but the root won't match anything an on-chain
 *  `CommitmentPool` has published. Phase 5 swaps this for a
 *  real Merkle proof maintained from `CommitmentInserted` events. */
// `zeros[i]` = the all-zero sibling at level i of an empty tree. Only
// depends on `COMMIT_TREE_DEPTH` and the Poseidon hash, so it's
// process-static. Cache the *promise* (not the resolved value) so two
// concurrent first-callers share one computation instead of racing
// to compute it twice.
let zerosPromise: Promise<readonly bigint[]> | null = null;

function getZeros(): Promise<readonly bigint[]> {
  if (zerosPromise) return zerosPromise;
  zerosPromise = (async () => {
    const poseidon = await getPoseidonModule();
    const zeros: bigint[] = [0n];
    for (let i = 1; i <= COMMIT_TREE_DEPTH; i++) {
      zeros.push(poseidonHashWith(poseidon, [zeros[i - 1]!, zeros[i - 1]!]));
    }
    return zeros;
  })();
  return zerosPromise;
}

export async function buildEmptyTreeProof(
  note: CommitmentNote,
): Promise<{ commitment: bigint; merkleProof: MerkleProof; leafIndex: number }> {
  const [poseidon, zeros, commitment] = await Promise.all([
    getPoseidonModule(),
    getZeros(),
    computeCommitment(note),
  ]);

  // Walk leaf → root, hashing with the right zero sibling at each
  // level. pathIndices are all 0 because the leaf sits at index 0.
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let current = commitment;
  for (let i = 0; i < COMMIT_TREE_DEPTH; i++) {
    pathElements.push(zeros[i]!);
    pathIndices.push(0);
    current = poseidonHashWith(poseidon, [current, zeros[i]!]);
  }

  return {
    commitment,
    merkleProof: { root: current, pathElements, pathIndices },
    leafIndex: 0,
  };
}
