import {
  type SerializedCommitmentNote,
  type SerializedMerkleProof,
} from "./commitment";
import type { CancelProofInput, CancelProofResult } from "./cancel-prover";

// structuredClone supports bigint + Uint8Array natively so the wire
// format mirrors the runtime shape; only `eddsaPrivateKey` needs a
// defensive copy in `serializeCancelInput` so the post-postMessage
// `wipeSerialized` zeros the throwaway buffer rather than the caller's.

export interface SerializedCancelInput {
  note: SerializedCommitmentNote;
  leafIndex: number;
  allLeaves?: bigint[];
  merkleProof?: SerializedMerkleProof;
  nonce: bigint;
  relayer: string;
  eddsaPrivateKey: Uint8Array;
}

export type SerializedCancelOutput = CancelProofResult;

export function serializeCancelInput(input: CancelProofInput): SerializedCancelInput {
  return {
    note: input.note,
    leafIndex: input.leafIndex,
    allLeaves: input.allLeaves,
    merkleProof: input.merkleProof,
    nonce: input.nonce,
    relayer: input.relayer,
    // Defensive copy — see file header.
    eddsaPrivateKey: new Uint8Array(input.eddsaPrivateKey),
  };
}

export function deserializeCancelInput(raw: SerializedCancelInput): CancelProofInput {
  return raw;
}

export function serializeCancelOutput(out: CancelProofResult): SerializedCancelOutput {
  return out;
}

export function deserializeCancelOutput(raw: SerializedCancelOutput): CancelProofResult {
  return raw;
}
