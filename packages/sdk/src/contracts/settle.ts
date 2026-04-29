import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_IFACE } from "../core/contracts";
import { toBytes32Hex } from "../zk/commitment";
import type { AuthorizeProofResult } from "../zk/circuits/authorize";
import type { CircuitTier } from "../zk/constants";

/** Per-side fee in token units the relayer charges, capped by the
 *  user's signed `maxFee` on each side. */
export interface SettleAuthFees {
  feeTokenMaker: bigint;
  feeTokenTaker: bigint;
}

/** Per-side public material the contract re-checks against the
 *  proof. The `proof` carries hashes only; these scalars match
 *  the user-signed order. */
export interface SettleAuthSide {
  proof: AuthorizeProofResult;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  relayer: string;
  /** Circuit tier this proof was generated against — passed straight
   *  through to the verifier-registry dispatch on-chain. Use a
   *  {@link CircuitTier}'s `cap` from `@zkscatter/sdk/zk` rather than
   *  a literal so an unsupported tier fails at compile time. */
  tier: CircuitTier["cap"];
}

function packAuthorize(side: SettleAuthSide) {
  const { proof: r } = side;
  return {
    proofA: r.proof.a,
    proofB: r.proof.b,
    proofC: r.proof.c,
    pubKeyBind: toBytes32Hex(r.pubKeyBind),
    commitmentRoot: r.commitmentRoot,
    nullifier: toBytes32Hex(r.nullifier),
    nonceNullifier: toBytes32Hex(r.nonceNullifier),
    newCommitment: toBytes32Hex(r.newCommitment),
    sellToken: side.sellToken,
    buyToken: side.buyToken,
    sellAmount: side.sellAmount,
    buyAmount: side.buyAmount,
    maxFee: side.maxFee,
    expiry: side.expiry,
    claimsRoot: toBytes32Hex(r.claimsRoot),
    totalLocked: r.totalLocked,
    relayer: side.relayer,
    orderHash: toBytes32Hex(r.orderHash),
    tier: side.tier,
  };
}

/** Send `PrivateSettlement.settleAuth(...)`. Relayer-only — the
 *  contract enforces `msg.sender ∈ {maker.relayer, taker.relayer}`. */
export async function callSettleAuth(
  signer: ethers.Signer,
  settlementAddress: string,
  maker: SettleAuthSide,
  taker: SettleAuthSide,
  fees: SettleAuthFees,
): Promise<ethers.TransactionResponse> {
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_IFACE, signer);
  return settlement.settleAuth({
    maker: packAuthorize(maker),
    taker: packAuthorize(taker),
    feeTokenMaker: fees.feeTokenMaker,
    feeTokenTaker: fees.feeTokenTaker,
  }) as Promise<ethers.TransactionResponse>;
}

/** Send `PrivateSettlement.scatterDirectAuth(...)` — Pay-style same-
 *  token self-pay (no counterparty, no DEX). The contract enforces:
 *  - `proof.sellToken === proof.buyToken` (same-token invariant)
 *  - `msg.sender == proof.relayer` is registered (or registry unset)
 *  - the authorize proof's tier has a verifier registered
 *
 *  The single `fee` is in the same token as the proof — drawn from
 *  the user's totalLocked, capped against the user-signed `maxFee`,
 *  and routed to `proof.relayer` via FeeVault (or directly when
 *  FeeVault is unset). Pass `0n` for self-relayer flows. */
export async function callScatterDirectAuth(
  signer: ethers.Signer,
  settlementAddress: string,
  side: SettleAuthSide,
  fee: bigint,
): Promise<ethers.TransactionResponse> {
  const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_IFACE, signer);
  return settlement.scatterDirectAuth({
    proof: packAuthorize(side),
    fee,
  }) as Promise<ethers.TransactionResponse>;
}
