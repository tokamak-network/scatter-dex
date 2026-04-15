// structuredClone supports bigint + Uint8Array natively, so the wire
// format mirrors the runtime shape and most fields pass through
// unchanged. The serde functions stay for API symmetry with the other
// `Serialized*` types — they make the wire-vs-runtime boundary visible
// at every call site even when the conversion is a no-op.
//
// `eddsaPrivateKey` keeps its native Uint8Array but `serializeAuthorizeInput`
// makes a defensive copy so the post-postMessage `wipeSerialized` zeros
// only the throwaway copy, not the caller's buffer.

import {
  serializeMerkleProof,
  deserializeMerkleProof,
  type SerializedCommitmentNote,
  type SerializedMerkleProof,
} from "./commitment";
import type {
  AuthorizeProofInput,
  AuthorizeProofResult,
  ClaimEntry,
} from "./authorize-prover";

// Claims pass through as-is — same shape on both sides of postMessage.
type SerializedClaim = ClaimEntry;

export interface SerializedAuthorizeInput {
  note: SerializedCommitmentNote;
  leafIndex: number;
  allLeaves?: bigint[];
  merkleProof?: SerializedMerkleProof;
  sellAmount: bigint;
  buyToken: string;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  nonce: bigint;
  relayer: string;
  eddsaPrivateKey: Uint8Array;
  claims: SerializedClaim[];
  newSalt?: bigint;
}

export interface SerializedAuthorizeOutput {
  proof: AuthorizeProofResult["proof"];
  publicSignals: string[];
  commitmentRoot: bigint;
  nullifier: bigint;
  nonceNullifier: bigint;
  newCommitment: bigint;
  claimsRoot: bigint;
  totalLocked: bigint;
  orderHash: bigint;
}

export function serializeAuthorizeInput(input: AuthorizeProofInput): SerializedAuthorizeInput {
  const result: SerializedAuthorizeInput = {
    note: input.note,
    leafIndex: input.leafIndex,
    sellAmount: input.sellAmount,
    buyToken: input.buyToken,
    buyAmount: input.buyAmount,
    maxFee: input.maxFee,
    expiry: input.expiry,
    nonce: input.nonce,
    relayer: input.relayer,
    // Defensive copy — see file header.
    eddsaPrivateKey: new Uint8Array(input.eddsaPrivateKey),
    claims: input.claims,
  };
  if (input.allLeaves) {
    result.allLeaves = input.allLeaves;
  }
  if (input.merkleProof) {
    result.merkleProof = serializeMerkleProof(input.merkleProof);
  }
  if (input.newSalt !== undefined) {
    result.newSalt = input.newSalt;
  }
  return result;
}

export function deserializeAuthorizeInput(raw: SerializedAuthorizeInput): AuthorizeProofInput {
  return {
    note: raw.note,
    leafIndex: raw.leafIndex,
    allLeaves: raw.allLeaves,
    merkleProof: raw.merkleProof ? deserializeMerkleProof(raw.merkleProof) : undefined,
    sellAmount: raw.sellAmount,
    buyToken: raw.buyToken,
    buyAmount: raw.buyAmount,
    maxFee: raw.maxFee,
    expiry: raw.expiry,
    nonce: raw.nonce,
    relayer: raw.relayer,
    eddsaPrivateKey: raw.eddsaPrivateKey,
    claims: raw.claims,
    newSalt: raw.newSalt,
  };
}

export function serializeAuthorizeOutput(out: AuthorizeProofResult): SerializedAuthorizeOutput {
  return out;
}

export function deserializeAuthorizeOutput(raw: SerializedAuthorizeOutput): AuthorizeProofResult {
  return raw;
}
