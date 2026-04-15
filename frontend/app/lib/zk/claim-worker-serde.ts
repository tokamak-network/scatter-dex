// structuredClone supports bigint natively, so input/output pass
// through unchanged. The serde functions stay for API symmetry with
// the other `Serialized*` types — they make the wire-vs-runtime
// boundary visible at every call site even when the conversion is a
// no-op.

import type { ClaimProofInput, ClaimProofResult } from "./claim-prover";

export type SerializedClaimInput = ClaimProofInput;
export type SerializedClaimOutput = ClaimProofResult;

export function serializeClaimInput(input: ClaimProofInput): SerializedClaimInput {
  return input;
}

export function deserializeClaimInput(raw: SerializedClaimInput): ClaimProofInput {
  return raw;
}

export function serializeClaimOutput(out: ClaimProofResult): SerializedClaimOutput {
  return out;
}

export function deserializeClaimOutput(raw: SerializedClaimOutput): ClaimProofResult {
  return raw;
}
