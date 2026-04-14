/**
 * Sparse Poseidon Merkle tree via ZKBridgeService.
 *
 * The commitment pool uses a 2^20 = 1,048,576-leaf tree. Naively padding to
 * full width and hashing every node would do ~1M bridge round-trips per
 * cancel / settle, which hangs the WebView. Instead we only store the
 * non-zero prefix at each level and substitute a precomputed `zeroHashes[d]`
 * wherever a sibling falls in the all-zero region.
 *
 * Hash count for `n` actual leaves and depth `d`:
 *   - ~`2n + d` bridge hashes (worst case; `2n − 1` once the prefix collapses
 *     to one element at every remaining level).
 *   - For n ≈ 100, d = 20: ~115 hashes vs ~1M for the naive builder.
 *
 * The returned `root` is bit-identical to what the naive tree would produce
 * — this is a perf rewrite, not a protocol change.
 *
 * Zero hashes themselves are protocol constants (`ZEROS` in
 * `contracts/src/zk/IncrementalMerkleTree.sol`); hardcoding them here saves
 * the 20 sequential bridge round-trips the former `computeZeroHashes`
 * precompute would cost per call.
 */
import { ZKBridgeService } from '../services/ZKBridgeService';

/**
 * `ZEROS[d]` = hash of an all-zero subtree of height `d` (with `ZEROS[0] = '0'`).
 * Indices 0..19 match `IncrementalMerkleTree.sol._zeros(d)` exactly. Index 20
 * is the all-zero root for the depth-20 commitment tree — the contract
 * computes it implicitly in its constructor (`_zeros()` reverts above 19),
 * and we precompute it here so a depth-20 build doesn't need an extra bridge
 * round-trip. Mirrors `frontend/app/lib/zk/incremental-tree.ts`. Any change
 * here is a consensus break.
 */
const ZEROS: readonly string[] = [
  '0',
  '0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864',
  '0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1',
  '0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238',
  '0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a',
  '0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55',
  '0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78',
  '0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d',
  '0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61',
  '0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747',
  '0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2',
  '0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636',
  '0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a',
  '0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0',
  '0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c',
  '0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92',
  '0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323',
  '0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992',
  '0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f',
  '0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca',
  '0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e',
];

export interface SparseMerkleTree {
  /** Root of the full 2^depth tree (same value the naive builder would produce). */
  root: string;
  /** `layers[d]` = values at level d, truncated to the non-zero prefix. */
  layers: string[][];
  /** `zeroHashes[d]` = hash of an all-zero subtree of height d (`zeroHashes[0] === '0'`). */
  zeroHashes: readonly string[];
  depth: number;
}

/**
 * Build a sparse Poseidon Merkle tree.
 *
 * `leaves` is the caller's actual leaf values (NOT pre-padded — the sparse
 * implementation fills the rest of the 2^depth capacity with zero hashes
 * automatically).
 */
export async function buildPoseidonMerkleTree(
  leaves: string[],
  depth: number,
): Promise<SparseMerkleTree> {
  const capacity = 2 ** depth;
  if (leaves.length > capacity) {
    throw new Error(`Too many leaves: ${leaves.length} exceeds tree capacity ${capacity}`);
  }
  if (depth >= ZEROS.length) {
    throw new Error(`depth ${depth} exceeds precomputed ZEROS table (max ${ZEROS.length - 1})`);
  }

  const layers: string[][] = [[...leaves]];
  let current = layers[0];

  for (let d = 0; d < depth; d++) {
    if (current.length === 0) {
      // No non-zero values remain — the rest of the tree is all zeros.
      // Fill remaining layers from the precomputed `ZEROS` table, then
      // point `current` at the root layer so the final `current[0]`
      // return reads the all-zero root instead of `undefined`.
      for (let dd = d; dd < depth; dd++) {
        layers.push([ZEROS[dd + 1]]);
      }
      current = layers[layers.length - 1];
      break;
    }
    // Pipeline hashes within a level. Each pair is still its own bridge
    // postMessage — the bridge has no batch-hash command yet — but the
    // single `await` below lets them all be in-flight together rather than
    // sequenced (~N → 1 effective wait at the JS layer).
    //
    // Cap the in-flight count so we don't queue thousands of requests
    // against the bridge's per-request 10s timeout. With ~64 in flight at
    // once, even a depth-20 tree with ~500k pairs at level 0 stays inside
    // the timeout window per chunk.
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : ZEROS[d];
      pairs.push([left, right]);
    }
    const next: string[] = new Array(pairs.length);
    const CONCURRENCY = 64;
    for (let off = 0; off < pairs.length; off += CONCURRENCY) {
      const chunk = pairs.slice(off, off + CONCURRENCY);
      const hashed = await Promise.all(
        chunk.map((p) => ZKBridgeService.poseidonHash(p)),
      );
      for (let i = 0; i < hashed.length; i++) next[off + i] = hashed[i];
    }
    layers.push(next);
    current = next;
  }

  // After `depth` iterations the prefix always has exactly one element —
  // the root of the full 2^depth tree.
  return { root: current[0], layers, zeroHashes: ZEROS, depth };
}

/**
 * Extract a Merkle proof for `leafIndex` (0-based, into the full 2^depth
 * tree). Sibling values come from the sparse layers when present, and fall
 * back to the level's zero hash otherwise.
 */
export function getMerkleProofFromTree(
  treeOrLayers: SparseMerkleTree | string[][],
  leafIndex: number,
  zeroHashesOrUndef?: readonly string[],
): { pathElements: string[]; pathIndices: string[] } {
  // Keep the old (layers, leafIndex) call shape working for callers that
  // already pre-pad their trees to full width (e.g. the 16-leaf claims
  // tree). In that case there are no zero siblings anywhere on the path
  // and `zeroHashes` is unused.
  const isTree = !Array.isArray(treeOrLayers);
  const layers = isTree ? treeOrLayers.layers : treeOrLayers;
  const zeroHashes = isTree ? treeOrLayers.zeroHashes : (zeroHashesOrUndef ?? ZEROS);
  const depth = layers.length - 1;
  const capacity = 2 ** depth;

  if (leafIndex < 0 || leafIndex >= capacity) {
    throw new Error(`Merkle proof: leafIndex ${leafIndex} out of bounds [0, ${capacity})`);
  }
  // Refuse to produce a proof for a leaf index the caller has no value for —
  // using ZEROS[0] as the leaf would silently fabricate a proof of membership
  // for the zero leaf at that position.
  if (leafIndex >= layers[0].length) {
    throw new Error(
      `Merkle proof: leafIndex ${leafIndex} is in the zero region (only ${layers[0].length} actual leaves provided)`,
    );
  }

  const pathElements: string[] = [];
  const pathIndices: string[] = [];
  let idx = leafIndex;

  for (let d = 0; d < depth; d++) {
    const isRight = idx % 2;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = siblingIdx < layers[d].length
      ? layers[d][siblingIdx]
      : (zeroHashes[d] ?? '0');
    pathElements.push(sibling);
    pathIndices.push(isRight.toString());
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}
