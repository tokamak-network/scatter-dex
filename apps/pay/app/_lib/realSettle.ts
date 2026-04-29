"use client";

import { ethers } from "ethers";
import {
  assembleAuthorizeProofResult,
  randomFieldElement,
  TIER_16,
  type PayoutBatch,
} from "@zkscatter/sdk/zk";
import { callScatterDirectAuth, type SettleAuthSide } from "@zkscatter/sdk/contracts";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";
import { getAuthorizeProver } from "./authorizeProver";
import type { CommitmentTreeState } from "./commitmentTree";
import type { PickedNote } from "./sourceNotes";

/** User-facing copy for the staged-rollout limits. Single source so
 *  page.tsx and realSettle.ts can't drift on the wording. */
export const PHASE_1C_MULTI_BATCH_MSG =
  "This run needs more than one settlement transaction — multi-batch payouts arrive in Phase 1c.";
export const PHASE_1C_MULTI_NOTE_MSG =
  "This run needs more than one source note — multi-note coverage arrives in Phase 1c.";
export const PHASE_1B_PARTIAL_SPEND_MSG =
  "Phase 1b only supports a single source note that exactly covers the run total.";

export interface RealSettleArgs {
  batch: PayoutBatch;
  tokenAddress: string;
  source: PickedNote;
  relayer: RelayerInfo;
  /** Wallet-backed signer + the on-chain settlement address it will
   *  call. Grouped so a future `chainContext` (e.g. router, paymaster)
   *  can extend without further argument churn. */
  chain: { signer: ethers.Signer; settlementAddress: string };
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
 *  AuthorizeProof tuple, and submit `scatterDirectAuth`. */
export async function realSettle(args: RealSettleArgs): Promise<RealSettleResult> {
  const { batch, tokenAddress, source, relayer, chain, maxFeeBps, eddsaPrivateKey, tree } = args;
  const stored = source.note;

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
  if (source.spend !== batch.totalAmount) {
    throw new Error(PHASE_1B_PARTIAL_SPEND_MSG);
  }

  // self-pay invariant: sellToken == buyToken, sellAmount == buyAmount
  const sellAmount = batch.totalAmount;
  const buyAmount = batch.totalAmount;
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
  const authResult = assembleAuthorizeProofResult(result);

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
  const tx = await callScatterDirectAuth(chain.signer, chain.settlementAddress, side, 0n);
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
