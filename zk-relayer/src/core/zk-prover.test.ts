import { describe, it, expect } from "vitest";
import { buildMerkleTree, getMerkleProof, poseidonHash } from "./zk-prover.js";

const DEPTH = 4;

// Naive reference impl: pads to 2^depth, hashes everything. Slow but
// trivially correct — we use it as a black-box oracle for the sparse
// builder.
async function naiveTree(leaves: bigint[], depth: number) {
  const size = 2 ** depth;
  const padded = [...leaves];
  while (padded.length < size) padded.push(0n);
  const layers: bigint[][] = [padded];
  let cur = padded;
  for (let i = 0; i < depth; i++) {
    const next: bigint[] = [];
    for (let j = 0; j < cur.length; j += 2) {
      next.push(await poseidonHash([cur[j], cur[j + 1]]));
    }
    layers.push(next);
    cur = next;
  }
  return { root: cur[0], layers };
}

function naiveProof(layers: bigint[][], leafIndex: number) {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let idx = leafIndex;
  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = idx % 2;
    const sib = isRight ? idx - 1 : idx + 1;
    pathElements.push(layers[i][sib] ?? 0n);
    pathIndices.push(isRight);
    idx = Math.floor(idx / 2);
  }
  return { pathElements, pathIndices };
}

describe("sparse buildMerkleTree", () => {
  it.each([
    ["empty", [] as bigint[]],
    ["single leaf", [42n]],
    ["odd count", [1n, 2n, 3n]],
    ["even count", [1n, 2n, 3n, 4n]],
    ["full width", [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n]],
  ])("root matches naive — %s", async (_label, leaves) => {
    const sparse = await buildMerkleTree(leaves, DEPTH);
    const naive = await naiveTree(leaves, DEPTH);
    expect(sparse.root).toBe(naive.root);
  });

  it("getMerkleProof matches naive for every present leaf", async () => {
    const leaves = [11n, 22n, 33n, 44n, 55n];
    const sparse = await buildMerkleTree(leaves, DEPTH);
    const naive = await naiveTree(leaves, DEPTH);
    for (let i = 0; i < leaves.length; i++) {
      const sp = getMerkleProof(sparse, i);
      const nv = naiveProof(naive.layers, i);
      expect(sp.pathElements).toEqual(nv.pathElements);
      expect(sp.pathIndices).toEqual(nv.pathIndices);
    }
  });

  it("getMerkleProof matches naive for indices in the all-zero region", async () => {
    const leaves = [11n, 22n];
    const sparse = await buildMerkleTree(leaves, DEPTH);
    const naive = await naiveTree(leaves, DEPTH);
    for (const i of [3, 7, 15]) {
      const sp = getMerkleProof(sparse, i);
      const nv = naiveProof(naive.layers, i);
      expect(sp.pathElements).toEqual(nv.pathElements);
      expect(sp.pathIndices).toEqual(nv.pathIndices);
    }
  });
});
