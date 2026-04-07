import { describe, it, expect } from "vitest";
import { IncrementalMerkleTree } from "../src/core/incremental-tree.js";
import { buildMerkleTree } from "../src/core/zk-prover.js";

describe("IncrementalMerkleTree", () => {
  const DEPTH = 4; // Small depth for fast tests

  it("empty tree root matches full rebuild", async () => {
    const tree = new IncrementalMerkleTree(DEPTH);
    const { root: fullRoot } = await buildMerkleTree([], DEPTH);
    expect(tree.root).toBe(fullRoot);
  });

  it("single insert matches full rebuild", async () => {
    const tree = new IncrementalMerkleTree(DEPTH);
    const leaf = 12345n;
    await tree.insert(leaf);

    const { root: fullRoot } = await buildMerkleTree([leaf], DEPTH);
    expect(tree.root).toBe(fullRoot);
    expect(tree.nextIndex).toBe(1);
  });

  it("multiple inserts match full rebuild", async () => {
    const leaves = [100n, 200n, 300n, 400n, 500n];
    const tree = new IncrementalMerkleTree(DEPTH);
    for (const leaf of leaves) await tree.insert(leaf);

    const { root: fullRoot } = await buildMerkleTree(leaves, DEPTH);
    expect(tree.root).toBe(fullRoot);
    expect(tree.nextIndex).toBe(5);
  });

  it("getProof produces valid Merkle path", async () => {
    const leaves = [10n, 20n, 30n, 40n];
    const tree = new IncrementalMerkleTree(DEPTH);
    for (const leaf of leaves) await tree.insert(leaf);

    const { root: fullRoot, layers } = await buildMerkleTree(leaves, DEPTH);

    for (let i = 0; i < leaves.length; i++) {
      const proof = await tree.getProof(i);
      expect(proof.pathElements.length).toBe(DEPTH);
      expect(proof.pathIndices.length).toBe(DEPTH);

      // Verify proof matches full tree's getMerkleProof
      const { getMerkleProof } = await import("../src/core/zk-prover.js");
      const fullProof = getMerkleProof(layers, i);
      expect(proof.pathElements).toEqual(fullProof.pathElements);
      expect(proof.pathIndices).toEqual(fullProof.pathIndices);
    }
  });

  it("fromLeaves rebuilds identical tree", async () => {
    const leaves = [111n, 222n, 333n, 444n, 555n, 666n];
    const tree = await IncrementalMerkleTree.fromLeaves(leaves, DEPTH);

    const { root: fullRoot } = await buildMerkleTree(leaves, DEPTH);
    expect(tree.root).toBe(fullRoot);
    expect(tree.nextIndex).toBe(6);
  });

  it("full capacity (2^depth) works", async () => {
    const leaves = Array.from({ length: 2 ** DEPTH }, (_, i) => BigInt(i + 1));
    const tree = new IncrementalMerkleTree(DEPTH);
    for (const leaf of leaves) await tree.insert(leaf);

    const { root: fullRoot } = await buildMerkleTree(leaves, DEPTH);
    expect(tree.root).toBe(fullRoot);
    expect(tree.nextIndex).toBe(2 ** DEPTH);
  });

  it("insert beyond capacity throws", async () => {
    const tree = new IncrementalMerkleTree(2); // capacity = 4
    for (let i = 0; i < 4; i++) await tree.insert(BigInt(i));
    await expect(tree.insert(99n)).rejects.toThrow("tree full");
  });

  it("getProof out of range throws", async () => {
    const tree = new IncrementalMerkleTree(DEPTH);
    await tree.insert(1n);
    await expect(tree.getProof(-1)).rejects.toThrow("out of range");
    await expect(tree.getProof(1)).rejects.toThrow("out of range");
  });

  it("depth 20 insert is fast", async () => {
    const tree = new IncrementalMerkleTree(20);
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await tree.insert(BigInt(i + 1));
    }
    const elapsed = Date.now() - start;
    console.log(`100 inserts at depth 20: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(500);
  });
});
