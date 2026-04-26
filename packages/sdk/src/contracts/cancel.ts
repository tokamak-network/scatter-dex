import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_IFACE } from "../core/contracts";
import { toBytes32Hex } from "../zk/commitment";
import type { CancelProofResult } from "../zk/circuits/cancel";

/** Send `PrivateSettlement.cancelPrivate(...)`. Anyone can submit
 *  on behalf of the user; the cancel proof binds `msg.sender` (the
 *  relayer) into the signed cancel message, so a different relayer
 *  cannot replay the proof.
 *
 *  After the tx mines:
 *   - The old commitment is permanently dead (escrowNullifier
 *     burnt)
 *   - The order is dropped from the orderbook (relayers see the
 *     `PrivateCancel` event keyed by `nonceNullifier`)
 *   - The fresh `newCommitment` is inserted into the pool with the
 *     same balance, immediately spendable for a new order. */
export async function callCancel(
  signer: ethers.Signer,
  settlementAddress: string,
  proof: CancelProofResult,
): Promise<ethers.TransactionResponse> {
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_IFACE, signer);
  const { a, b, c } = proof.proof;
  return settlement.cancelPrivate({
    proofA: a,
    proofB: b,
    proofC: c,
    commitmentRoot: proof.commitmentRoot,
    oldNullifier: toBytes32Hex(proof.oldNullifier),
    oldNonceNullifier: toBytes32Hex(proof.oldNonceNullifier),
    newCommitment: toBytes32Hex(proof.newCommitment),
  }) as Promise<ethers.TransactionResponse>;
}
