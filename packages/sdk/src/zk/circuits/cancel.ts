/** Groth16 proof generator for the escrow-rotation cancel circuit
 *  (`cancel.circom`).
 *
 *  Cancel proves:
 *   1. The user owns a commitment in the on-chain pool's Merkle tree
 *   2. The escrow nullifier is correctly derived (the old commitment
 *      dies)
 *   3. The nonce nullifier is correctly derived (the specific order
 *      dies — relayers see the event and drop it from the orderbook)
 *   4. A fresh commitment is constructed with the same balance and a
 *      new salt (escrow rotates, the user can immediately re-order)
 *   5. The user holds the EdDSA key bound into the commitment
 *
 *  Circuit size ≈ 8K constraints; proving runs ~1–2 s on desktop and
 *  5–9 s on mobile, hence the worker offload pattern in apps.
 *
 *  Ported from `frontend/app/lib/zk/cancel-prover.ts`. The result
 *  shape uses SDK conventions (`Groth16Proof` carries BigInts; the
 *  contract-call helpers stringify at the boundary). */

import {
  computeCommitment,
  computeNonceNullifier,
  computeNullifier,
  poseidonHash,
  randomFieldElement,
  type CommitmentNote,
  type MerkleProof,
} from "../commitment";
import { signEdDSA } from "../eddsa";
import { buildMerkleTree, getMerkleProof } from "../merkle";
import { COMMIT_TREE_DEPTH } from "../constants";
import { wipeBytes } from "../secureWipe";
import { formatGroth16Proof, type SnarkjsRawProof } from "../proofFormat";
import type { Groth16Proof } from "../types";
import type { CircuitAssets } from "./deposit";

export interface CancelProofInput {
  /** The user's escrow commitment note (v2 — includes BabyJub pubkey). */
  note: CommitmentNote;
  /** Index of this commitment's leaf in the on-chain Merkle tree. */
  leafIndex: number;
  /** All commitment leaves in the pool. Required when `merkleProof`
   *  is omitted. */
  allLeaves?: bigint[];
  /** Pre-computed Merkle proof — recommended once the pool grows past
   *  a few thousand leaves; skipping the O(2^depth) rebuild is the
   *  difference between sub-second and multi-second cancel cost. */
  merkleProof?: MerkleProof;
  /** Nonce of the order being cancelled. */
  nonce: bigint;
  /** EdDSA private key bound into `note`'s commitment. Caller-owned;
   *  the prover wipes its own working copy after signing. */
  eddsaPrivateKey: Uint8Array;
  /** Address of the relayer that will submit the cancel tx — pinned
   *  in the cancel message so a different relayer can't replay it. */
  relayer: string;
}

export interface CancelProofResult {
  proof: Groth16Proof;
  publicSignals: readonly bigint[];
  commitmentRoot: bigint;
  oldNullifier: bigint;
  oldNonceNullifier: bigint;
  newCommitment: bigint;
  /** Fresh salt for the rotated commitment — the caller must persist
   *  this so the new note can be spent later (same balance, new
   *  salt). */
  freshSalt: bigint;
}

/** Cancel circuit's public-input order, in the same order the
 *  `.circom` declares them. Mirrored by the contract verifier's
 *  scalar arguments. Change one, change both — the constant lives
 *  here so consumers can't drift from it. */
export const CANCEL_PUBLIC_SIGNALS = [
  "commitmentRoot",
  "oldNullifier",
  "oldNonceNullifier",
  "newCommitment",
  "relayer",
] as const;

/** Reconstruct a rich `CancelProofResult` from the slim
 *  `{ proof, publicSignals }` envelope a Web Worker passes back.
 *  The cancel circuit's private `freshSalt` is *not* in
 *  `publicSignals`; it isn't needed by the on-chain `cancelPrivate`
 *  call (the contract doesn't take it), but vault rotation
 *  persistence (writing the rotated note with the new salt) is
 *  blocked until the worker protocol gains a `meta` channel —
 *  callers that need rotation must produce the proof on-thread.
 *  Until then this returns `freshSalt: 0n` and that path is gated
 *  off in apps. */
export function assembleCancelProofResult(envelope: {
  proof: Groth16Proof;
  publicSignals: readonly bigint[];
}): CancelProofResult {
  const ps = envelope.publicSignals;
  if (ps.length < 4) {
    throw new Error(
      `assembleCancelProofResult: ${ps.length} public signals; expected ≥ 4`,
    );
  }
  return {
    proof: envelope.proof,
    publicSignals: ps,
    commitmentRoot: ps[0]!,
    oldNullifier: ps[1]!,
    oldNonceNullifier: ps[2]!,
    newCommitment: ps[3]!,
    freshSalt: 0n,
  };
}

interface SnarkjsModule {
  groth16: {
    fullProve: (
      input: Record<string, unknown>,
      wasm: CircuitAssets["wasm"],
      zkey: CircuitAssets["zkey"],
    ) => Promise<{
      proof: SnarkjsRawProof;
      publicSignals: string[];
    }>;
  };
}

export async function generateCancelProof(
  input: CancelProofInput,
  assets: CircuitAssets,
): Promise<CancelProofResult> {
  const snarkjs = (await import("snarkjs")) as unknown as SnarkjsModule;

  const commitment = await computeCommitment(input.note);

  let commitmentRoot: bigint;
  let pathElements: bigint[];
  let pathIndices: number[];

  if (input.merkleProof) {
    ({ root: commitmentRoot, pathElements, pathIndices } = input.merkleProof);
  } else if (input.allLeaves) {
    if (input.leafIndex < 0 || input.leafIndex >= input.allLeaves.length) {
      throw new Error(
        `generateCancelProof: leafIndex ${input.leafIndex} out of range for ${input.allLeaves.length} leaves`,
      );
    }
    if (input.allLeaves[input.leafIndex] !== commitment) {
      throw new Error(
        "generateCancelProof: commitment does not match the leaf at the given index",
      );
    }
    const tree = await buildMerkleTree(input.allLeaves, COMMIT_TREE_DEPTH);
    commitmentRoot = tree.root;
    const proof = getMerkleProof(tree.layers, input.leafIndex);
    pathElements = proof.pathElements;
    pathIndices = proof.pathIndices;
  } else {
    throw new Error(
      "generateCancelProof: provide either `merkleProof` or `allLeaves`",
    );
  }

  const oldNullifier = await computeNullifier(input.note);
  const oldNonceNullifier = await computeNonceNullifier(
    input.note.ownerSecret,
    input.nonce,
  );

  // Rotate the escrow: same balance + token, fresh salt. Derive the
  // new commitment via `computeCommitment` so the v2 commitment
  // format (tag, field order) lives in exactly one place. The loop
  // guards Poseidon hashing to 0 (negligible probability but would
  // brick the rotated balance on-chain) and a freshSalt collision
  // with the existing salt (would produce an identical commitment,
  // defeating the rotation).
  let freshSalt: bigint;
  let newCommitment = 0n;
  do {
    freshSalt = randomFieldElement();
    if (freshSalt === input.note.salt) continue;
    newCommitment = await computeCommitment({ ...input.note, salt: freshSalt });
  } while (newCommitment === 0n);

  // cancelMsg = Poseidon(oldNonceNullifier, relayer). Distinct from
  // authorize's orderHash so the same EdDSA key signing both flows
  // can't produce a cross-replayable signature.
  const relayer = BigInt(input.relayer);
  const cancelMsg = await poseidonHash([oldNonceNullifier, relayer]);
  const signingKey = Uint8Array.from(input.eddsaPrivateKey);
  let sig;
  try {
    sig = await signEdDSA(signingKey, cancelMsg);
  } finally {
    // Wipe the local copy only — caller's buffer is theirs to manage.
    wipeBytes(signingKey);
  }

  const circuitInput: Record<string, unknown> = {
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

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    assets.wasm,
    assets.zkey,
  );

  if (!Array.isArray(publicSignals) || publicSignals.length === 0) {
    throw new Error(
      "generateCancelProof: snarkjs returned no publicSignals — circuit/wasm mismatch?",
    );
  }

  return {
    proof: formatGroth16Proof(proof),
    publicSignals: publicSignals.map((s) => BigInt(s)),
    commitmentRoot,
    oldNullifier,
    oldNonceNullifier,
    newCommitment,
    freshSalt,
  };
}
