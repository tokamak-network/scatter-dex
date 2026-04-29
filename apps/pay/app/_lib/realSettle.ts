"use client";

import { ethers } from "ethers";
import {
  randomFieldElement,
  TIER_16,
  type AuthorizeProofResult,
  type PayoutBatch,
} from "@zkscatter/sdk/zk";
import { callScatterDirectAuth, type SettleAuthSide } from "@zkscatter/sdk/contracts";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";
import type { StoredNote } from "@zkscatter/sdk/notes";
import { getAuthorizeProver } from "./authorizeProver";
import type { CommitmentTreeState } from "./commitmentTree";
import type { PickedNote } from "./sourceNotes";

export interface RealSettleArgs {
  batch: PayoutBatch;
  tokenAddress: string;
  source: PickedNote;
  relayer: RelayerInfo;
  signer: ethers.Signer;
  settlementAddress: string;
  /** User-signed cap on the relayer's deduction. Pay's self-pay flow
   *  hands no fee through (`fee=0`), but the cap still binds the
   *  proof so the relayer can't claim more later. */
  maxFeeBps: number;
  eddsaPrivateKey: Uint8Array;
  tree: CommitmentTreeState;
}

export interface RealSettleResult {
  txHash: string;
  nullifier: bigint;
  claimsRoot: bigint;
}

/** Pay's single-batch real settle. Mirrors zk-relayer/test/
 *  e2e-scatter-direct-auth.ts steps 3–5: build merkle proof from the
 *  on-chain tree, prove off-thread in the worker, pack the
 *  AuthorizeProof tuple, and submit `scatterDirectAuth`. Multi-batch
 *  + change-UTXO tracking ships in Phase 1c. */
export async function realSettle(args: RealSettleArgs): Promise<RealSettleResult> {
  const {
    batch,
    tokenAddress,
    source,
    relayer,
    signer,
    settlementAddress,
    maxFeeBps,
    eddsaPrivateKey,
    tree,
  } = args;

  const stored: StoredNote = source.note;
  if (stored.leafIndex < 0) {
    throw new Error(
      "Source note's deposit hasn't been confirmed on-chain yet — wait for the next block.",
    );
  }
  const merkleProof = await tree.tryProofFor(stored.commitment);
  if (!merkleProof) {
    throw new Error(
      "Source note isn't in the on-chain commitment tree yet — try again once the tree finishes syncing.",
    );
  }
  // Single-batch / single-source-note scope. Multi-note coverage ships
  // in Phase 1c together with proper change-UTXO tracking.
  if (source.spend !== batch.totalAmount) {
    throw new Error(
      "Phase 1b only supports a single source note that exactly covers the run total.",
    );
  }

  const sellAmount = batch.totalAmount;
  const buyAmount = batch.totalAmount; // self-pay: same token, same amount
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const nonce = randomFieldElement();
  const newSalt = randomFieldElement();

  const prover = getAuthorizeProver();
  const result = await prover.prove({
    circuitId: "authorize",
    input: {
      note: stored.note,
      leafIndex: stored.leafIndex,
      merkleProof,
      sellAmount,
      buyToken: tokenAddress,
      buyAmount,
      maxFee: BigInt(maxFeeBps),
      expiry,
      nonce,
      relayer: relayer.address,
      eddsaPrivateKey,
      claims: batch.claims,
      newSalt,
    },
  });

  const meta = result.meta;
  if (!meta) {
    throw new Error("authorize.worker returned no meta — extracted scalars are missing");
  }
  const authResult: AuthorizeProofResult = {
    proof: result.proof,
    publicSignals: result.publicSignals,
    pubKeyBind: meta.pubKeyBind!,
    commitmentRoot: meta.commitmentRoot!,
    nullifier: meta.nullifier!,
    nonceNullifier: meta.nonceNullifier!,
    newCommitment: meta.newCommitment!,
    claimsRoot: meta.claimsRoot!,
    totalLocked: meta.totalLocked!,
    orderHash: meta.orderHash!,
  };

  const side: SettleAuthSide = {
    proof: authResult,
    sellToken: tokenAddress,
    buyToken: tokenAddress,
    sellAmount,
    buyAmount,
    maxFee: BigInt(maxFeeBps),
    expiry,
    relayer: relayer.address,
    tier: TIER_16.cap,
  };
  const tx = await callScatterDirectAuth(signer, settlementAddress, side, 0n);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`scatterDirectAuth tx failed: ${tx.hash}`);
  }
  return {
    txHash: tx.hash,
    nullifier: authResult.nullifier,
    claimsRoot: authResult.claimsRoot,
  };
}
