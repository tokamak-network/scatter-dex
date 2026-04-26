import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_IFACE } from "../core/contracts";
import { toBytes32Hex } from "../zk/commitment";
import type { ClaimProofResult } from "../zk/circuits/claim";

/** Public-input scalars the contract receives alongside the proof.
 *  These MUST match the values the caller passed to
 *  `generateClaimProof` — passing different scalars and the matching
 *  proof together would fail on-chain verification. */
export interface ClaimCallInputs {
  recipient: string;
  token: string;
  amount: bigint;
  releaseTime: bigint;
}

/** Send `PrivateSettlement.claimWithProof(...)`. Anyone can submit
 *  on behalf of the recipient (the address is encoded in the
 *  public signals), so a relayer can dispatch gaslessly. */
export async function callClaimWithProof(
  signer: ethers.Signer,
  settlementAddress: string,
  proof: ClaimProofResult,
  inputs: ClaimCallInputs,
): Promise<ethers.TransactionResponse> {
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_IFACE, signer);
  const { a, b, c } = proof.proof;
  return settlement.claimWithProof(
    a, b, c,
    toBytes32Hex(proof.claimsRoot),
    toBytes32Hex(proof.nullifier),
    inputs.amount,
    inputs.token,
    inputs.recipient,
    inputs.releaseTime,
  ) as Promise<ethers.TransactionResponse>;
}

export interface BatchClaimItem {
  proof: ClaimProofResult;
  inputs: ClaimCallInputs;
}

/** Hard cap enforced by `PrivateSettlement.claimWithProofBatch`.
 *  Mirrors the contract's `MAX_CLAIM_BATCH_SIZE` constant; an
 *  oversized batch reverts on-chain after burning gas, so we
 *  catch it client-side. Callers chunk larger sets. */
export const MAX_CLAIM_BATCH_SIZE = 20;

/** Batch variant. Reverts atomically if any element is invalid;
 *  caps at `MAX_CLAIM_BATCH_SIZE` (caller chunks larger sets). */
export async function callClaimWithProofBatch(
  signer: ethers.Signer,
  settlementAddress: string,
  items: BatchClaimItem[],
): Promise<ethers.TransactionResponse> {
  if (items.length === 0) {
    throw new Error("callClaimWithProofBatch: empty batch");
  }
  if (items.length > MAX_CLAIM_BATCH_SIZE) {
    throw new Error(
      `callClaimWithProofBatch: batch size ${items.length} exceeds MAX_CLAIM_BATCH_SIZE (${MAX_CLAIM_BATCH_SIZE}). Chunk and call repeatedly.`,
    );
  }
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_IFACE, signer);
  const params = items.map((it) => {
    const { a, b, c } = it.proof.proof;
    return {
      proofA: a,
      proofB: b,
      proofC: c,
      claimsRoot: toBytes32Hex(it.proof.claimsRoot),
      claimNullifier: toBytes32Hex(it.proof.nullifier),
      amount: it.inputs.amount,
      token: it.inputs.token,
      recipient: it.inputs.recipient,
      releaseTime: it.inputs.releaseTime,
    };
  });
  return settlement.claimWithProofBatch(params) as Promise<ethers.TransactionResponse>;
}
