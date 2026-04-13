/**
 * Shared Poseidon Merkle tree builder via ZKBridgeService.
 */
import { ZKBridgeService } from '../services/ZKBridgeService';

/**
 * Compute the Merkle root and proof path for a single leaf without building
 * the full 2^depth tree.  Instead of padding to 2^depth leaves and issuing
 * 2^depth WebView round-trips, this function:
 *
 *  1. Pre-computes zero hashes for each level  (depth hashes, run in serial).
 *  2. Processes each level in parallel, keeping only enough nodes to cover
 *     the path node and its sibling.  Empty positions are substituted with
 *     the pre-computed zero hash for that level, skipping the Poseidon call.
 *
 * Complexity: O(N) Poseidon hashes where N = leaves.length, instead of
 * O(2^depth).  For the depth-20 commitment tree with a few hundred on-chain
 * commitments this reduces >1 000 000 WebView round-trips to a few hundred.
 *
 * The resulting root is identical to the full-tree root because the circuit
 * uses the same zero-hash convention for empty subtrees.
 */
export async function computeMerkleRootAndPath(
  leaves: string[],
  leafIndex: number,
  depth: number,
): Promise<{ root: string; pathElements: string[]; pathIndices: string[] }> {
  if (leaves.length === 0) {
    throw new Error('computeMerkleRootAndPath: leaves array must not be empty');
  }
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(
      `computeMerkleRootAndPath: leafIndex ${leafIndex} out of bounds [0, ${leaves.length})`,
    );
  }

  // Step 1 — pre-compute zero hashes serially (each depends on the previous).
  const zeroHashes: string[] = ['0'];
  for (let i = 1; i <= depth; i++) {
    zeroHashes.push(
      await ZKBridgeService.poseidonHash([zeroHashes[i - 1], zeroHashes[i - 1]]),
    );
  }

  const pathElements: string[] = [];
  const pathIndices: string[] = [];

  let layer: string[] = [...leaves];

  for (let d = 0; d < depth; d++) {
    const pathPos = leafIndex >> d;
    const siblingPos = pathPos ^ 1;

    // Sibling may be beyond the actual layer — use the zero hash in that case.
    const sibling = siblingPos < layer.length ? layer[siblingPos] : zeroHashes[d];
    pathElements.push(sibling);
    pathIndices.push((pathPos & 1).toString());

    // Build the next layer in parallel, but only up to the minimum size
    // needed to keep the path node and its sibling at the next level.
    const nextSize = Math.ceil(layer.length / 2);
    const hashPromises: Promise<string>[] = [];
    for (let i = 0; i < nextSize; i++) {
      const left = layer[2 * i];
      const right = 2 * i + 1 < layer.length ? layer[2 * i + 1] : zeroHashes[d];
      // Skip the Poseidon call when both inputs are the zero value for this level.
      if (left === zeroHashes[d] && right === zeroHashes[d]) {
        hashPromises.push(Promise.resolve(zeroHashes[d + 1]));
      } else {
        hashPromises.push(ZKBridgeService.poseidonHash([left, right]));
      }
    }
    layer = await Promise.all(hashPromises);
  }

  const root = layer[0] ?? zeroHashes[depth];
  return { root, pathElements, pathIndices };
}

/**
 * @deprecated Use `computeMerkleRootAndPath` for large trees (depth ≥ 10).
 * This function pads leaves to 2^depth and issues one WebView call per node —
 * prohibitively expensive for depth-20 trees (>1 M round-trips).
 *
 * Kept for small claim trees (depth=4, 16 leaves) where the overhead is
 * acceptable and callers already depend on the `layers` return value.
 */
export async function buildPoseidonMerkleTree(
  leaves: string[],
  depth: number,
): Promise<{ root: string; layers: string[][] }> {
  const size = 2 ** depth;
  if (leaves.length > size) {
    throw new Error(`Too many leaves: ${leaves.length} exceeds tree capacity ${size}`);
  }
  const padded = [...leaves];
  while (padded.length < size) padded.push('0');

  const layers: string[][] = [padded];
  let current = padded;

  for (let d = 0; d < depth; d++) {
    const promises: Promise<string>[] = [];
    for (let i = 0; i < current.length; i += 2) {
      promises.push(ZKBridgeService.poseidonHash([current[i], current[i + 1]]));
    }
    const next = await Promise.all(promises);
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers };
}

export function getMerkleProofFromTree(
  layers: string[][],
  leafIndex: number,
): { pathElements: string[]; pathIndices: string[] } {
  const pathElements: string[] = [];
  const pathIndices: string[] = [];
  if (leafIndex < 0 || leafIndex >= layers[0].length) {
    throw new Error(`Merkle proof: leafIndex ${leafIndex} out of bounds [0, ${layers[0].length})`);
  }
  let idx = leafIndex;

  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = idx % 2;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    if (siblingIdx >= layers[i].length) {
      throw new Error(`Merkle proof: sibling index ${siblingIdx} out of bounds at level ${i}`);
    }
    pathElements.push(layers[i][siblingIdx]);
    pathIndices.push(isRight.toString());
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}
