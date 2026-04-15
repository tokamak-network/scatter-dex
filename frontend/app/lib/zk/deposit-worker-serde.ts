import {
  serializeCommitmentNote,
  deserializeCommitmentNote,
  type CommitmentNote,
  type SerializedCommitmentNote,
} from "./commitment";
import type { DepositProofResult } from "./deposit-prover";

export type SerializedDepositInput = SerializedCommitmentNote;

export interface SerializedDepositOutput {
  commitment: string;
  proof: DepositProofResult["proof"];
}

export function serializeDepositInput(note: CommitmentNote): SerializedDepositInput {
  return serializeCommitmentNote(note);
}

export function deserializeDepositInput(raw: SerializedDepositInput): CommitmentNote {
  return deserializeCommitmentNote(raw);
}

export function serializeDepositOutput(out: DepositProofResult): SerializedDepositOutput {
  return {
    commitment: out.commitment.toString(),
    proof: out.proof,
  };
}

export function deserializeDepositOutput(raw: SerializedDepositOutput): DepositProofResult {
  return {
    commitment: BigInt(raw.commitment),
    proof: raw.proof,
  };
}
