/**
 * ZK Proof generation for escrow rotation cancel (cancel.circom).
 * Uses snarkjs WASM prover in the browser.
 *
 * Cancel proof proves:
 *   1. The user owns a commitment in the Merkle tree
 *   2. The escrow nullifier is correctly derived (→ commitment dies)
 *   3. The nonce nullifier is correctly derived (→ specific order dies)
 *   4. A new commitment with the same balance + new salt is created
 *   5. The user holds the EdDSA key bound in the commitment
 *
 * After the on-chain cancelPrivate() tx mines:
 *   - The old commitment is permanently dead
 *   - The old authorize order cannot be settled (escrow nullifier burnt)
 *   - The user has a fresh commitment and can make new orders immediately
 *   - Relayers detect the PrivateCancel event and remove the order from
 *     their orderbook (by matching the nonceNullifier)
 *
 * Circuit size: ~8K constraints. Proof time: ~1-2s in browser.
 */

import type { CommitmentNote } from "./commitment";
import {
  computeCommitment,
  computeNullifier,
  computeNonceNullifier,
  buildMerkleTree,
  getMerkleProof,
  randomFieldElement,
  poseidonHash,
  formatProofForSolidity,
} from "./commitment";
import { signEdDSA } from "./eddsa";
import { TAG_COMMITMENT_V2 } from "./tags";
import { COMMIT_TREE_DEPTH } from "./constants";

const WASM_PATH = "/zk/cancel.wasm";
const ZKEY_PATH = "/zk/cancel_final.zkey";

export interface CancelProofInput {
  /** The user's escrow commitment note (v2 format with BabyJub pubkey). */
  note: CommitmentNote;

  /** Index of this commitment's leaf in the on-chain Merkle tree. */
  leafIndex: number;

  /**
   * All commitment leaves in the pool. Required unless `merkleProof` is
   * provided. Same as in authorize-prover.ts.
   */
  allLeaves?: bigint[];

  /** Pre-computed Merkle proof (skip O(n) tree rebuild for large pools). */
  merkleProof?: {
    root: bigint;
    pathElements: bigint[];
    pathIndices: number[];
  };

  /** The nonce of the order to cancel. */
  nonce: bigint;

  /** The EdDSA private key (same key used to sign the order). */
  eddsaPrivateKey: Uint8Array;

  /** Address of the relayer submitting the cancel tx. */
  relayer: string;
}

export interface CancelProofResult {
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
  publicSignals: string[];
  commitmentRoot: bigint;
  oldNullifier: bigint;
  oldNonceNullifier: bigint;
  newCommitment: bigint;
  /** The new salt — frontend must save this to update the note file. */
  freshSalt: bigint;
}

/**
 * Generate an escrow rotation cancel proof in the browser.
 * Estimated proof time: ~1-2 seconds on desktop.
 */
export async function generateCancelProof(
  input: CancelProofInput,
): Promise<CancelProofResult> {
  const snarkjs = await import("snarkjs");

  // ── 1. Commitment membership ──
  const commitment = await computeCommitment(input.note);

  let commitmentRoot: bigint;
  let pathElements: bigint[];
  let pathIndices: number[];

  if (input.merkleProof) {
    ({ root: commitmentRoot, pathElements, pathIndices } = input.merkleProof);
  } else if (input.allLeaves) {
    if (input.leafIndex < 0 || input.leafIndex >= input.allLeaves.length) {
      throw new Error(`Invalid leafIndex ${input.leafIndex} for ${input.allLeaves.length} leaves`);
    }
    if (input.allLeaves[input.leafIndex] !== commitment) {
      throw new Error("Commitment does not match the leaf at the given index.");
    }
    const tree = await buildMerkleTree(input.allLeaves, COMMIT_TREE_DEPTH);
    commitmentRoot = tree.root;
    const proof = getMerkleProof(tree.layers, input.leafIndex);
    pathElements = proof.pathElements;
    pathIndices = proof.pathIndices;
  } else {
    throw new Error("Either allLeaves or merkleProof must be provided");
  }

  // ── 2. Nullifiers ──
  const oldNullifier = await computeNullifier(input.note);
  const oldNonceNullifier = await computeNonceNullifier(
    input.note.ownerSecret,
    input.nonce,
  );

  // ── 3. New commitment (escrow rotation — same balance, new salt) ──
  // Loop until newCommitment != 0 (Poseidon can theoretically output 0
  // with negligible probability, but if it does the on-chain cancel
  // would brick the balance). Also ensure freshSalt != old salt to
  // avoid generating an identical commitment.
  let freshSalt: bigint;
  let newCommitment: bigint = 0n;
  do {
    freshSalt = randomFieldElement();
    if (freshSalt === input.note.salt) continue; // avoid same-salt rotation
    newCommitment = await poseidonHash([
      TAG_COMMITMENT_V2,
      input.note.ownerSecret,
      input.note.token,
      input.note.amount, // balance stays the same
      freshSalt,
      input.note.pubKeyAx,
      input.note.pubKeyAy,
    ]);
  } while (newCommitment === 0n);

  // ── 4. Cancel message + EdDSA signature ──
  // cancelMsg = Poseidon(oldNonceNullifier, relayer)
  // Distinct from orderHash (Poseidon-9) so signatures are not cross-replayable.
  const relayer = BigInt(input.relayer);
  const cancelMsg = await poseidonHash([oldNonceNullifier, relayer]);
  const sig = await signEdDSA(input.eddsaPrivateKey, cancelMsg);
  // [S-M12] Zero private key immediately after signing — no longer needed
  input.eddsaPrivateKey.fill(0);

  // ── 5. Assemble circuit input ──
  const circuitInput = {
    // Public
    commitmentRoot: commitmentRoot.toString(),
    oldNullifier: oldNullifier.toString(),
    oldNonceNullifier: oldNonceNullifier.toString(),
    newCommitment: newCommitment.toString(),
    relayer: relayer.toString(),
    // Private
    secret: input.note.ownerSecret.toString(),
    salt: input.note.salt.toString(),
    nonce: input.nonce.toString(),
    token: input.note.token.toString(),
    balance: input.note.amount.toString(),
    freshSalt: freshSalt.toString(),
    path: pathElements.map((e) => e.toString()),
    pathIdx: pathIndices.map((i) => i.toString()),
    pubKeyAx: input.note.pubKeyAx.toString(),
    pubKeyAy: input.note.pubKeyAy.toString(),
    sigS: sig.S.toString(),
    sigR8x: sig.R8x.toString(),
    sigR8y: sig.R8y.toString(),
  };

  // ── 6. Generate Groth16 proof ──
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  return {
    proof: formatProofForSolidity(proof),
    publicSignals,
    commitmentRoot,
    oldNullifier,
    oldNonceNullifier,
    newCommitment,
    freshSalt, // frontend needs this to update the note file
  };
}
