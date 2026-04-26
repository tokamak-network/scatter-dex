import { poseidonHash } from "./commitment";

/** A built Poseidon Merkle tree. `layers[0]` is the leaf layer
 *  (padded to `2^depth`); `layers[depth]` is the root layer (one
 *  element). Suitable input for `getMerkleProof`. */
export interface BuiltTree {
  root: bigint;
  layers: bigint[][];
}

/** Build a Poseidon Merkle tree of the given depth from `leaves`.
 *  The leaf array is padded with the leaf-level zero (`0n`) up to
 *  `2^depth`; internal zero values are derived by hashing the level
 *  below.
 *
 *  Cost: O(2^depth) Poseidon hashes. For the protocol's
 *  `COMMIT_TREE_DEPTH = 20`, that's roughly a million hashes —
 *  several seconds on desktop, longer on mobile. Apps that maintain
 *  an incremental tree should pre-compute `MerkleProof`s and pass
 *  them through `AuthorizeProofInput.merkleProof` instead of asking
 *  the prover to rebuild from scratch each time. */
export async function buildMerkleTree(
  leaves: bigint[],
  depth: number,
): Promise<BuiltTree> {
  if (depth < 1) throw new Error("buildMerkleTree: depth must be ≥ 1");

  const size = 1 << depth;
  const padded = leaves.slice(0, size);
  while (padded.length < size) padded.push(0n);

  const layers: bigint[][] = [padded];
  let current = padded;
  for (let level = 0; level < depth; level++) {
    const next: bigint[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(await poseidonHash([current[i]!, current[i + 1]!]));
    }
    layers.push(next);
    current = next;
  }
  return { root: current[0]!, layers };
}

/** Inclusion proof for a single leaf in a `BuiltTree`. */
export interface MerklePathProof {
  pathElements: bigint[];
  pathIndices: number[];
}

/** Walk a `BuiltTree` from leaf to root, collecting siblings. The
 *  returned `pathIndices[i]` is `1` when the original leaf is on
 *  the right side of its sibling at level `i`, `0` otherwise —
 *  matching the convention every Circom Merkle template uses. */
export function getMerkleProof(
  layers: bigint[][],
  leafIndex: number,
): MerklePathProof {
  if (layers.length < 2) {
    throw new Error("getMerkleProof: tree must have at least one internal layer");
  }
  if (leafIndex < 0 || leafIndex >= layers[0]!.length) {
    throw new Error(`getMerkleProof: leafIndex ${leafIndex} out of range`);
  }
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let idx = leafIndex;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const isRight = idx % 2;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    pathElements.push(layer[siblingIdx] ?? 0n);
    pathIndices.push(isRight);
    idx = Math.floor(idx / 2);
  }
  return { pathElements, pathIndices };
}
