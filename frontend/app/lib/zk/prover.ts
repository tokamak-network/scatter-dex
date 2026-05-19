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
  poseidonHash,
  randomFieldElement,
} from "./commitment";
import { signEdDSA } from "./eddsa";
import { wipeBytes } from "./secure-wipe";
import { CIRCUIT_ASSETS } from "./constants";
import { timeProve } from "./prove-timer";
import { withCachedAssets } from "./zkey-cache";

export interface WithdrawProofInput {
  note: CommitmentNote;
  leafIndex: number;
  allLeaves: bigint[]; // all commitment leaves in the tree (from events)
  treeDepth: number;
  withdrawAmount: bigint;
  recipient: string; // address
  relayer?: string; // address, default 0x0
  /** EdDSA private key bound into the note's commitment via
   *  `pubKeyAx/Ay`. The withdraw circuit now requires a signature
   *  over `Poseidon(nullifierHash, recipient)` — the note file
   *  alone is no longer sufficient. */
  eddsaPrivateKey: Uint8Array;
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

  // Reject obviously-wrong inputs up front: `deriveEdDSAKey` always
  // emits 32 bytes. An empty/short buffer means the caller forgot to
  // unlock the trading key — surface a clear error instead of letting
  // circomlibjs throw an opaque "invalid prv key" later.
  if (input.eddsaPrivateKey.length !== 32) {
    throw new Error(
      `generateWithdrawProof: eddsaPrivateKey must be 32 bytes, got ${input.eddsaPrivateKey.length}`,
    );
  }

  // EdDSA gate: sign Poseidon(nullifierHash, recipient). The
  // circuit reconstructs the same hash and verifies the signature
  // inside `EdDSAPoseidonVerifier`. The withdrawer must hold the
  // wallet's EdDSA key (derived from `personal_sign`) — a stolen
  // note file alone can't produce this signature.
  const withdrawMsg = await poseidonHash([nullifierHash, BigInt(recipient)]);
  const signingKey = Uint8Array.from(input.eddsaPrivateKey);
  let sig;
  try {
    sig = await signEdDSA(signingKey, withdrawMsg);
  } finally {
    wipeBytes(signingKey);
  }

  // Build Merkle tree and get proof
  const { root, layers } = await buildMerkleTree(allLeaves, treeDepth);
  const { pathElements, pathIndices } = getMerkleProof(layers, leafIndex);

  // [issue #128] Change commitment must use the same v2 format as the
  // original — tagged Poseidon including the same pubkey. Using the
  // shared TAG constant keeps this in lock-step with the circuit.
  const changeAmount = note.amount - withdrawAmount;
  let newCommitment = 0n;
  let newSalt = 0n;
  if (changeAmount > 0n) {
    newSalt = randomFieldElement();
    const { buildPoseidon } = await import("circomlibjs");
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const { TAG_COMMITMENT_V2 } = await import("./tags");
    const h = poseidon([
      TAG_COMMITMENT_V2,
      note.ownerSecret,
      note.token,
      changeAmount,
      newSalt,
      note.pubKeyAx,
      note.pubKeyAy,
    ]);
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
    // [issue #128] Pubkey the commitment was originally bound to — the
    // circuit recomputes `Poseidon(TAG_V2, secret, token, amount, salt,
    // Ax, Ay)` internally and checks merkle membership against it.
    pubKeyAx: note.pubKeyAx.toString(),
    pubKeyAy: note.pubKeyAy.toString(),
    sigS: sig.S.toString(),
    sigR8x: sig.R8x.toString(),
    sigR8y: sig.R8y.toString(),
  };

  // Generate proof
  const { proof, publicSignals } = await withCachedAssets(
    CIRCUIT_ASSETS.withdraw,
    ({ wasm, zkey }) =>
      timeProve("withdraw", () => snarkjs.groth16.fullProve(circuitInput, wasm, zkey)),
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
