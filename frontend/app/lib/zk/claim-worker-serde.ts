import type { ClaimProofInput, ClaimProofResult } from "./claim-prover";

export interface SerializedClaimInput {
  secret: string;
  recipient: string;
  token: string;
  amount: string;
  releaseTime: string;
  leafIndex: number;
  allClaimLeaves: string[];
}

export interface SerializedClaimOutput {
  proof: ClaimProofResult["proof"];
  publicSignals: string[];
  claimsRoot: string;
  nullifier: string;
}

export function serializeClaimInput(input: ClaimProofInput): SerializedClaimInput {
  return {
    secret: input.secret.toString(),
    recipient: input.recipient.toString(),
    token: input.token.toString(),
    amount: input.amount.toString(),
    releaseTime: input.releaseTime.toString(),
    leafIndex: input.leafIndex,
    allClaimLeaves: input.allClaimLeaves.map((l) => l.toString()),
  };
}

export function deserializeClaimInput(raw: SerializedClaimInput): ClaimProofInput {
  return {
    secret: BigInt(raw.secret),
    recipient: BigInt(raw.recipient),
    token: BigInt(raw.token),
    amount: BigInt(raw.amount),
    releaseTime: BigInt(raw.releaseTime),
    leafIndex: raw.leafIndex,
    allClaimLeaves: raw.allClaimLeaves.map(BigInt),
  };
}

export function serializeClaimOutput(out: ClaimProofResult): SerializedClaimOutput {
  return {
    proof: out.proof,
    publicSignals: out.publicSignals,
    claimsRoot: out.claimsRoot.toString(),
    nullifier: out.nullifier.toString(),
  };
}

export function deserializeClaimOutput(raw: SerializedClaimOutput): ClaimProofResult {
  return {
    proof: raw.proof,
    publicSignals: raw.publicSignals,
    claimsRoot: BigInt(raw.claimsRoot),
    nullifier: BigInt(raw.nullifier),
  };
}
