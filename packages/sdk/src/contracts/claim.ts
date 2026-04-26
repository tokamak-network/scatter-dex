import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "../core/contracts";
import { toBytes32Hex } from "../zk/commitment";
import type { ClaimProofResult } from "../zk/circuits/claim";

/** Inputs the contract needs that aren't carried by the prover —
 *  the recipient address (it's a public input but lives outside
 *  the proof object), the token address (same), and the original
 *  release time. */
export interface ClaimCallExtras {
  recipient: string;
  token: string;
  amount: bigint;
  releaseTime: bigint;
}

/** Build and send `PrivateSettlement.claimWithProof(...)`.
 *
 *  Anyone can call this on behalf of the recipient; the recipient
 *  is encoded as a public signal so a relayer can submit gaslessly.
 *  Returns the pending `TransactionResponse`. */
export async function callClaimWithProof(
  signer: ethers.Signer,
  settlementAddress: string,
  proof: ClaimProofResult,
  extras: ClaimCallExtras,
): Promise<ethers.TransactionResponse> {
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_ABI, signer);
  return settlement.claimWithProof(
    proof.proof.a,
    proof.proof.b,
    proof.proof.c,
    toBytes32Hex(proof.claimsRoot),
    toBytes32Hex(proof.nullifier),
    extras.amount,
    extras.token,
    extras.recipient,
    extras.releaseTime,
  ) as Promise<ethers.TransactionResponse>;
}

export interface BatchClaimItem {
  proof: ClaimProofResult;
  extras: ClaimCallExtras;
}

/** Batch variant — submit several claims in one tx. The contract
 *  reverts atomically if any claim fails, so the caller must
 *  ensure every element is individually valid. Caps at the
 *  contract's `MAX_CLAIM_BATCH_SIZE`; chunk larger sets at the
 *  app layer. */
export async function callClaimWithProofBatch(
  signer: ethers.Signer,
  settlementAddress: string,
  items: BatchClaimItem[],
): Promise<ethers.TransactionResponse> {
  if (items.length === 0) {
    throw new Error("callClaimWithProofBatch: empty batch");
  }
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_ABI, signer);
  const params = items.map((it) => ({
    proofA: it.proof.proof.a,
    proofB: it.proof.proof.b,
    proofC: it.proof.proof.c,
    claimsRoot: toBytes32Hex(it.proof.claimsRoot),
    claimNullifier: toBytes32Hex(it.proof.nullifier),
    amount: it.extras.amount,
    token: it.extras.token,
    recipient: it.extras.recipient,
    releaseTime: it.extras.releaseTime,
  }));
  return settlement.claimWithProofBatch(params) as Promise<ethers.TransactionResponse>;
}
