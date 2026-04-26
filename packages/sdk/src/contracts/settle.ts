import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "../core/contracts";
import { toBytes32Hex } from "../zk/commitment";
import type { AuthorizeProofResult } from "../zk/circuits/authorize";

/** Per-side fee in token units the relayer charges. Capped by the
 *  user's signed `maxFee` on each side; this is the relayer's
 *  choice within that cap. */
export interface SettleAuthFees {
  feeTokenMaker: bigint;
  feeTokenTaker: bigint;
}

/** Convert an `AuthorizeProofResult` to the contract's
 *  `AuthorizeProof` calldata shape. The contract expects
 *  pubKeyBind/nullifier/etc as `bytes32`; we hex-pad here. */
function packAuthorize(r: AuthorizeProofResult, sellToken: string, buyToken: string, sellAmount: bigint, buyAmount: bigint, maxFee: bigint, expiry: bigint, relayer: string) {
  return {
    proofA: r.proof.a,
    proofB: r.proof.b,
    proofC: r.proof.c,
    pubKeyBind: toBytes32Hex(r.pubKeyBind),
    commitmentRoot: r.commitmentRoot,
    nullifier: toBytes32Hex(r.nullifier),
    nonceNullifier: toBytes32Hex(r.nonceNullifier),
    newCommitment: toBytes32Hex(r.newCommitment),
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    maxFee,
    expiry,
    claimsRoot: toBytes32Hex(r.claimsRoot),
    totalLocked: r.totalLocked,
    relayer,
    orderHash: toBytes32Hex(r.orderHash),
  };
}

/** Per-side public material that the contract needs alongside the
 *  prover output. The proof carries hashes only; the contract
 *  re-checks them against these scalars. */
export interface SettleAuthSide {
  proof: AuthorizeProofResult;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  relayer: string;
}

/** Build and send `PrivateSettlement.settleAuth(...)`.
 *
 *  This is a relayer-only call — the contract enforces
 *  `msg.sender ∈ {maker.relayer, taker.relayer}`. App-layer
 *  surfaces (apps/pro) won't call this directly; relayer ops
 *  dashboards / scripts will. */
export async function callSettleAuth(
  signer: ethers.Signer,
  settlementAddress: string,
  maker: SettleAuthSide,
  taker: SettleAuthSide,
  fees: SettleAuthFees,
): Promise<ethers.TransactionResponse> {
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_ABI, signer);
  const p = {
    maker: packAuthorize(
      maker.proof,
      maker.sellToken,
      maker.buyToken,
      maker.sellAmount,
      maker.buyAmount,
      maker.maxFee,
      maker.expiry,
      maker.relayer,
    ),
    taker: packAuthorize(
      taker.proof,
      taker.sellToken,
      taker.buyToken,
      taker.sellAmount,
      taker.buyAmount,
      taker.maxFee,
      taker.expiry,
      taker.relayer,
    ),
    feeTokenMaker: fees.feeTokenMaker,
    feeTokenTaker: fees.feeTokenTaker,
  };
  return settlement.settleAuth(p) as Promise<ethers.TransactionResponse>;
}
