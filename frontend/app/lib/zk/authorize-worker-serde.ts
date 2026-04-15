// bigint values are mostly carried natively across postMessage
// (structuredClone-safe), but `pubKey*` / amounts / nullifiers / claim
// fields stay as decimal strings to keep the wire format stable across
// platforms and to match the on-disk note-file shape consumers already
// use elsewhere. The eddsaPrivateKey is the one true zero-copy hot
// path — it's a Uint8Array round-trip and structuredClone takes its
// own copy on the worker side.

import {
  serializeCommitmentNote,
  deserializeCommitmentNote,
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

interface SerializedClaim {
  secret: string;
  recipient: string;
  token: string;
  amount: string;
  releaseTime: string;
}

export interface SerializedAuthorizeInput {
  note: SerializedCommitmentNote;
  leafIndex: number;
  allLeaves?: bigint[];
  merkleProof?: SerializedMerkleProof;
  sellAmount: string;
  buyToken: string;
  buyAmount: string;
  maxFee: string;
  expiry: string;
  nonce: string;
  relayer: string;
  // Defensive copy of the caller's Uint8Array — the wipe in
  // `wipeSerialized` zeros THIS copy, not the caller's buffer.
  eddsaPrivateKey: Uint8Array;
  claims: SerializedClaim[];
  newSalt?: string;
}

export interface SerializedAuthorizeOutput {
  proof: AuthorizeProofResult["proof"];
  publicSignals: string[];
  commitmentRoot: string;
  nullifier: string;
  nonceNullifier: string;
  newCommitment: string;
  claimsRoot: string;
  totalLocked: string;
  orderHash: string;
}

function serializeClaim(c: ClaimEntry): SerializedClaim {
  return {
    secret: c.secret.toString(),
    recipient: c.recipient,
    token: c.token,
    amount: c.amount.toString(),
    releaseTime: c.releaseTime.toString(),
  };
}

function deserializeClaim(c: SerializedClaim): ClaimEntry {
  return {
    secret: BigInt(c.secret),
    recipient: c.recipient,
    token: c.token,
    amount: BigInt(c.amount),
    releaseTime: BigInt(c.releaseTime),
  };
}

export function serializeAuthorizeInput(input: AuthorizeProofInput): SerializedAuthorizeInput {
  const result: SerializedAuthorizeInput = {
    note: serializeCommitmentNote(input.note),
    leafIndex: input.leafIndex,
    sellAmount: input.sellAmount.toString(),
    buyToken: input.buyToken,
    buyAmount: input.buyAmount.toString(),
    maxFee: input.maxFee.toString(),
    expiry: input.expiry.toString(),
    nonce: input.nonce.toString(),
    relayer: input.relayer,
    // Defensive copy: see `eddsaPrivateKey` field comment above.
    eddsaPrivateKey: new Uint8Array(input.eddsaPrivateKey),
    claims: input.claims.map(serializeClaim),
  };
  if (input.allLeaves) {
    result.allLeaves = input.allLeaves;
  }
  if (input.merkleProof) {
    result.merkleProof = serializeMerkleProof(input.merkleProof);
  }
  if (input.newSalt !== undefined) {
    result.newSalt = input.newSalt.toString();
  }
  return result;
}

export function deserializeAuthorizeInput(raw: SerializedAuthorizeInput): AuthorizeProofInput {
  return {
    note: deserializeCommitmentNote(raw.note),
    leafIndex: raw.leafIndex,
    allLeaves: raw.allLeaves,
    merkleProof: raw.merkleProof ? deserializeMerkleProof(raw.merkleProof) : undefined,
    sellAmount: BigInt(raw.sellAmount),
    buyToken: raw.buyToken,
    buyAmount: BigInt(raw.buyAmount),
    maxFee: BigInt(raw.maxFee),
    expiry: BigInt(raw.expiry),
    nonce: BigInt(raw.nonce),
    relayer: raw.relayer,
    eddsaPrivateKey: raw.eddsaPrivateKey,
    claims: raw.claims.map(deserializeClaim),
    newSalt: raw.newSalt !== undefined ? BigInt(raw.newSalt) : undefined,
  };
}

export function serializeAuthorizeOutput(out: AuthorizeProofResult): SerializedAuthorizeOutput {
  return {
    proof: out.proof,
    publicSignals: out.publicSignals,
    commitmentRoot: out.commitmentRoot.toString(),
    nullifier: out.nullifier.toString(),
    nonceNullifier: out.nonceNullifier.toString(),
    newCommitment: out.newCommitment.toString(),
    claimsRoot: out.claimsRoot.toString(),
    totalLocked: out.totalLocked.toString(),
    orderHash: out.orderHash.toString(),
  };
}

export function deserializeAuthorizeOutput(raw: SerializedAuthorizeOutput): AuthorizeProofResult {
  return {
    proof: raw.proof,
    publicSignals: raw.publicSignals,
    commitmentRoot: BigInt(raw.commitmentRoot),
    nullifier: BigInt(raw.nullifier),
    nonceNullifier: BigInt(raw.nonceNullifier),
    newCommitment: BigInt(raw.newCommitment),
    claimsRoot: BigInt(raw.claimsRoot),
    totalLocked: BigInt(raw.totalLocked),
    orderHash: BigInt(raw.orderHash),
  };
}
