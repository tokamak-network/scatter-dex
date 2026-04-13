/**
 * Shared Poseidon Merkle tree builder via ZKBridgeService.
 */
import { ZKBridgeService } from '../services/ZKBridgeService';

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
