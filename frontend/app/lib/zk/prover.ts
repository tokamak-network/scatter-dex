/**
 * ZK Proof generation for CommitmentPool withdrawals.
 * Uses snarkjs WASM prover in the browser.
 */

import type { CommitmentNote } from "./commitment";
import {
  computeCommitment,
  computeNullifier,
  computeTokenHash,
  buildMerkleTree,
  getMerkleProof,
  randomFieldElement,
} from "./commitment";

const WASM_PATH = "/zk/withdraw.wasm";
const ZKEY_PATH = "/zk/withdraw_final.zkey";

export interface WithdrawProofInput {
  note: CommitmentNote;
  leafIndex: number;
  allLeaves: bigint[]; // all commitment leaves in the tree (from events)
  treeDepth: number;
  withdrawAmount: bigint;
  recipient: string; // address
  relayer?: string; // address, default 0x0
}

export interface WithdrawProofResult {
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
  publicSignals: string[];
  root: bigint;
  nullifierHash: bigint;
  newCommitment: bigint;
  tokenHash: bigint;
}

/**
 * Generate a ZK withdrawal proof.
 * This runs in the browser using snarkjs WASM (~3-5 seconds).
 */
export async function generateWithdrawProof(
  input: WithdrawProofInput
): Promise<WithdrawProofResult> {
  // Dynamic import snarkjs (heavy library)
  const snarkjs = await import("snarkjs");

  const { note, leafIndex, allLeaves, treeDepth, withdrawAmount, recipient } = input;
  const relayer = input.relayer ?? "0x0000000000000000000000000000000000000000";

  // Compute values
  const commitment = await computeCommitment(note);
  const nullifierHash = await computeNullifier(note);
  const tokenHash = await computeTokenHash("0x" + note.token.toString(16).padStart(40, "0"));

  // Build Merkle tree and get proof
  const { root, layers } = await buildMerkleTree(allLeaves, treeDepth);
  const { pathElements, pathIndices } = getMerkleProof(layers, leafIndex);

  // Change commitment
  const changeAmount = note.amount - withdrawAmount;
  let newCommitment = 0n;
  let newSalt = 0n;
  if (changeAmount > 0n) {
    newSalt = randomFieldElement();
    // We need to import computeCommitment-like logic for the change
    const { buildPoseidon } = await import("circomlibjs");
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const h = poseidon([note.ownerSecret, note.token, changeAmount, newSalt]);
    newCommitment = F.toObject(h);
  }

  // Prepare circuit input
  const circuitInput = {
    // Public
    root: root.toString(),
    nullifierHash: nullifierHash.toString(),
    newCommitment: newCommitment.toString(),
    tokenHash: tokenHash.toString(),
    withdrawAmount: withdrawAmount.toString(),
    recipient: BigInt(recipient).toString(),
    relayer: BigInt(relayer).toString(),
    // Private
    ownerSecret: note.ownerSecret.toString(),
    token: note.token.toString(),
    amount: note.amount.toString(),
    salt: note.salt.toString(),
    newSalt: newSalt.toString(),
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices: pathIndices.map((i) => i.toString()),
  };

  // Generate proof
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH
  );

  return {
    proof: {
      a: [proof.pi_a[0], proof.pi_a[1]],
      b: [
        [proof.pi_b[0][1], proof.pi_b[0][0]], // note: reversed for Solidity
        [proof.pi_b[1][1], proof.pi_b[1][0]],
      ],
      c: [proof.pi_c[0], proof.pi_c[1]],
    },
    publicSignals,
    root,
    nullifierHash,
    newCommitment,
    tokenHash,
  };
}
