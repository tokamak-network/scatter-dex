// structuredClone supports bigint natively, so input/output pass
// through unchanged. The serde functions stay for API symmetry with
// the other `Serialized*` types — they make the wire-vs-runtime
// boundary visible at every call site even when the conversion is a
// no-op.

import type { CommitmentNote } from "./commitment";
import type { DepositProofResult } from "./deposit-prover";

export type SerializedDepositInput = CommitmentNote;
export type SerializedDepositOutput = DepositProofResult;

export function serializeDepositInput(note: CommitmentNote): SerializedDepositInput {
  return note;
}

export function deserializeDepositInput(raw: SerializedDepositInput): CommitmentNote {
  return raw;
}

export function serializeDepositOutput(out: DepositProofResult): SerializedDepositOutput {
  return out;
}

export function deserializeDepositOutput(raw: SerializedDepositOutput): DepositProofResult {
  return raw;
}
