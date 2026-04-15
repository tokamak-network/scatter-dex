import {
  serializeMerkleProof,
  deserializeMerkleProof,
  type SerializedCommitmentNote,
  type SerializedMerkleProof,
} from "./commitment";
import type { CancelProofInput, CancelProofResult } from "./cancel-prover";

export interface SerializedCancelInput {
  note: SerializedCommitmentNote;
  leafIndex: number;
  // Native bigint[] — structuredClone fast-path, matches the prover's
  // runtime shape so no per-leaf round-trip on 10K+ pools.
  allLeaves?: bigint[];
  merkleProof?: SerializedMerkleProof;
  nonce: string;
  relayer: string;
  // Defensive copy of the caller's Uint8Array — the wipe in
  // `wipeSerialized` zeros THIS copy, not the caller's buffer.
  eddsaPrivateKey: Uint8Array;
}

export interface SerializedCancelOutput {
  proof: CancelProofResult["proof"];
  publicSignals: string[];
  commitmentRoot: string;
  oldNullifier: string;
  oldNonceNullifier: string;
  newCommitment: string;
  freshSalt: string;
}

export function serializeCancelInput(input: CancelProofInput): SerializedCancelInput {
  const result: SerializedCancelInput = {
    note: input.note,
    leafIndex: input.leafIndex,
    nonce: input.nonce.toString(),
    relayer: input.relayer,
    // Defensive copy: see `eddsaPrivateKey` field comment above.
    eddsaPrivateKey: new Uint8Array(input.eddsaPrivateKey),
  };
  if (input.allLeaves) {
    result.allLeaves = input.allLeaves;
  }
  if (input.merkleProof) {
    result.merkleProof = serializeMerkleProof(input.merkleProof);
  }
  return result;
}

export function deserializeCancelInput(raw: SerializedCancelInput): CancelProofInput {
  return {
    note: raw.note,
    leafIndex: raw.leafIndex,
    allLeaves: raw.allLeaves,
    merkleProof: raw.merkleProof ? deserializeMerkleProof(raw.merkleProof) : undefined,
    nonce: BigInt(raw.nonce),
    relayer: raw.relayer,
    eddsaPrivateKey: raw.eddsaPrivateKey,
  };
}

export function serializeCancelOutput(out: CancelProofResult): SerializedCancelOutput {
  return {
    proof: out.proof,
    publicSignals: out.publicSignals,
    commitmentRoot: out.commitmentRoot.toString(),
    oldNullifier: out.oldNullifier.toString(),
    oldNonceNullifier: out.oldNonceNullifier.toString(),
    newCommitment: out.newCommitment.toString(),
    freshSalt: out.freshSalt.toString(),
  };
}

export function deserializeCancelOutput(raw: SerializedCancelOutput): CancelProofResult {
  return {
    proof: raw.proof,
    publicSignals: raw.publicSignals,
    commitmentRoot: BigInt(raw.commitmentRoot),
    oldNullifier: BigInt(raw.oldNullifier),
    oldNonceNullifier: BigInt(raw.oldNonceNullifier),
    newCommitment: BigInt(raw.newCommitment),
    freshSalt: BigInt(raw.freshSalt),
  };
}
