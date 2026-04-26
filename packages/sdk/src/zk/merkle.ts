import { getPoseidonModule, poseidonHashWith } from "./commitment";

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
 *  Awaits the Poseidon module **once** at the top, then hashes
 *  synchronously inside the loop. Awaiting per hash would cost a
 *  microtask per node — at `COMMIT_TREE_DEPTH = 20` (~1 M hashes)
 *  that becomes the dominant cost.
 *
 *  Apps that maintain an incremental tree should pre-compute
 *  `MerkleProof`s and pass them through `AuthorizeProofInput
 *  .merkleProof` instead of asking the prover to rebuild from
 *  scratch each call. */
export async function buildMerkleTree(
  leaves: bigint[],
  depth: number,
): Promise<BuiltTree> {
  if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
    // Bounded so the `1 << depth` shift below stays in 32-bit
    // signed range (depth=31 would produce a negative size). The
    // protocol's max depth is 20; any caller asking for >30 is
    // almost certainly mistaken about units.
    throw new Error("buildMerkleTree: depth must be an integer in [1, 30]");
  }
  const size = 1 << depth;
  if (leaves.length > size) {
    // `slice(0, size)` would silently truncate, producing a root
    // that doesn't match the caller's expectations. Surface the
    // mismatch instead.
    throw new Error(
      `buildMerkleTree: leaves.length (${leaves.length}) exceeds 2^${depth} (${size})`,
    );
  }

  const poseidon = await getPoseidonModule();

  const padded = leaves.slice();
  while (padded.length < size) padded.push(0n);

  const layers: bigint[][] = [padded];
  let current = padded;
  for (let level = 0; level < depth; level++) {
    const next: bigint[] = new Array(current.length >> 1);
    for (let i = 0, j = 0; i < current.length; i += 2, j++) {
      next[j] = poseidonHashWith(poseidon, [current[i]!, current[i + 1]!]);
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
    const sibling = layer[siblingIdx];
    if (sibling === undefined) {
      // A well-formed BuiltTree has every layer padded to a power
      // of two, so the sibling is always present. Falling back to
      // 0n would silently produce an invalid Merkle path that
      // only fails much later (snarkjs / on-chain). Throw instead.
      throw new Error(
        `getMerkleProof: layer ${level} missing sibling at index ${siblingIdx} (malformed tree)`,
      );
    }
    pathElements.push(sibling);
    pathIndices.push(isRight);
    idx = Math.floor(idx / 2);
  }
  return { pathElements, pathIndices };
}
