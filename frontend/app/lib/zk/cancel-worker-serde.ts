import {
  serializeCommitmentNote,
  deserializeCommitmentNote,
  type SerializedCommitmentNote,
} from "./commitment";
import type { CancelProofInput, CancelProofResult } from "./cancel-prover";

interface SerializedMerkleProof {
  root: string;
  pathElements: string[];
  pathIndices: number[];
}

export interface SerializedCancelInput {
  note: SerializedCommitmentNote;
  leafIndex: number;
  allLeaves?: string[];
  merkleProof?: SerializedMerkleProof;
  nonce: string;
  relayer: string;
  eddsaPrivateKey: number[];
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
    note: serializeCommitmentNote(input.note),
    leafIndex: input.leafIndex,
    nonce: input.nonce.toString(),
    relayer: input.relayer,
    eddsaPrivateKey: Array.from(input.eddsaPrivateKey),
  };
  if (input.allLeaves) {
    result.allLeaves = input.allLeaves.map((l) => l.toString());
  }
  if (input.merkleProof) {
    result.merkleProof = {
      root: input.merkleProof.root.toString(),
      pathElements: input.merkleProof.pathElements.map((e) => e.toString()),
      pathIndices: input.merkleProof.pathIndices,
    };
  }
  return result;
}

export function deserializeCancelInput(raw: SerializedCancelInput): CancelProofInput {
  return {
    note: deserializeCommitmentNote(raw.note),
    leafIndex: raw.leafIndex,
    allLeaves: raw.allLeaves?.map(BigInt),
    merkleProof: raw.merkleProof
      ? {
          root: BigInt(raw.merkleProof.root),
          pathElements: raw.merkleProof.pathElements.map(BigInt),
          pathIndices: raw.merkleProof.pathIndices,
        }
      : undefined,
    nonce: BigInt(raw.nonce),
    relayer: raw.relayer,
    eddsaPrivateKey: new Uint8Array(raw.eddsaPrivateKey),
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
