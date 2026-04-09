/**
 * ZK Proof generation for PrivateSettlement claims.
 * Uses snarkjs WASM prover in the browser.
 *
 * Claim proof proves:
 * 1. Knowledge of (secret) such that leaf = Poseidon(secret, recipient, token, amount, releaseTime)
 * 2. Leaf exists in the claimsRoot Merkle tree
 * 3. nullifier = Poseidon(secret, leafIndex)
 */

import { poseidonHash, buildMerkleTree, getMerkleProof } from "./commitment";

const CLAIMS_TREE_DEPTH = 4;

const WASM_PATH = "/zk/claim.wasm";
const ZKEY_PATH = "/zk/claim_final.zkey";

export interface ClaimProofInput {
  secret: bigint;
  recipient: bigint;  // address as bigint
  token: bigint;      // address as bigint
  amount: bigint;
  releaseTime: bigint;
  leafIndex: number;
  allClaimLeaves: bigint[];  // all 16 leaves (padded with 0n)
}

export interface ClaimProofResult {
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
  publicSignals: string[];
  claimsRoot: bigint;
  nullifier: bigint;
}

/**
 * Generate a ZK claim proof.
 * This runs in the browser using snarkjs WASM (~2-3 seconds).
 */
export async function generateClaimProof(
  input: ClaimProofInput
): Promise<ClaimProofResult> {
  const snarkjs = await import("snarkjs");

  // Validate leafIndex
  if (input.leafIndex < 0 || input.leafIndex >= input.allClaimLeaves.length) {
    throw new Error(`Invalid leafIndex ${input.leafIndex} for ${input.allClaimLeaves.length} claim leaves`);
  }

  // Compute and verify claim leaf hash matches the expected leaf in the tree
  const expectedLeaf = await poseidonHash([
    input.secret, input.recipient, input.token, input.amount, input.releaseTime,
  ]);
  if (input.allClaimLeaves[input.leafIndex] !== expectedLeaf) {
    throw new Error("Claim data does not match the leaf at the given index. Check your claim file.");
  }

  // [M4] Domain-separated claim nullifier = Poseidon(2, secret, leafIndex)
  const nullifier = await poseidonHash([2n, input.secret, BigInt(input.leafIndex)]);

  // Build claims Merkle tree (depth 4, 16 leaves)
  const { root: claimsRoot, layers } = await buildMerkleTree(input.allClaimLeaves, CLAIMS_TREE_DEPTH);

  // Get Merkle proof for this leaf
  const { pathElements, pathIndices } = getMerkleProof(layers, input.leafIndex);

  // Prepare circuit input
  const circuitInput = {
    // Public
    claimsRoot: claimsRoot.toString(),
    nullifier: nullifier.toString(),
    amount: input.amount.toString(),
    token: input.token.toString(),
    recipient: input.recipient.toString(),
    releaseTime: input.releaseTime.toString(),
    // Private
    secret: input.secret.toString(),
    leafIndex: input.leafIndex.toString(),
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices: pathIndices.map((i) => i.toString()),
  };

  // Generate proof
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  return {
    proof: {
      a: [proof.pi_a[0], proof.pi_a[1]],
      b: [
        [proof.pi_b[0][1], proof.pi_b[0][0]], // reversed for Solidity
        [proof.pi_b[1][1], proof.pi_b[1][0]],
      ],
      c: [proof.pi_c[0], proof.pi_c[1]],
    },
    publicSignals,
    claimsRoot,
    nullifier,
  };
}
