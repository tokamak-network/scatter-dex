"use client";

import { ethers } from "ethers";
import {
  assembleAuthorizeProofResult,
  buildClaimsTree,
  computeCommitment,
  getMerkleProof,
  randomFieldElement,
  TIER_16,
  toBytes32Hex,
  type CommitmentNote,
  type PayoutBatch,
} from "@zkscatter/sdk/zk";
import { callScatterDirectAuth, type SettleAuthSide } from "@zkscatter/sdk/contracts";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";
import type { ClaimPackage } from "@zkscatter/sdk/notes";
import { authorizeProver } from "./authorizeProver";
import type { CommitmentTreeState } from "./commitmentTree";
import type { PickedNote } from "./sourceNotes";

export interface RealSettleArgs {
  batch: PayoutBatch;
  tokenAddress: string;
  /** Display copy carried into each ClaimPackage so recipients see
   *  human values without an extra RPC. */
  tokenSymbol: string;
  tokenDecimals: number;
  source: PickedNote;
  relayer: RelayerInfo;
  /** Wallet-backed signer + the on-chain settlement address it will
   *  call. Grouped so a future `chainContext` (e.g. router, paymaster)
   *  can extend without further argument churn. */
  chain: { signer: ethers.Signer; settlementAddress: string; chainId: number };
  /** User-signed cap on the relayer's deduction. Pay's self-pay flow
   *  hands no fee through (`fee=0`), but the cap still binds the
   *  proof so the relayer can't claim more later. */
  maxFeeBps: number;
  eddsaPrivateKey: Uint8Array;
  tree: CommitmentTreeState;
  /** Optional sender / run labels echoed into each ClaimPackage so
   *  recipients see who sent it and which run it belongs to. */
  labels?: { sender?: string; run?: string };
}

export interface RealSettleResult {
  txHash: string;
  nullifier: bigint;
  claimsRoot: bigint;
  /** Residual change UTXO when the source note exceeded the spend.
   *  Caller persists this as a new vault note so the user can spend
   *  the leftover later; `null` when the note was fully consumed. */
  change: { note: CommitmentNote; commitment: bigint; amount: bigint } | null;
  /** One serializable package per recipient — operator distributes
   *  these (link, QR, email) so each recipient can claim against
   *  the on-chain claimsGroup. Index matches `batch.claims`. */
  claimPackages: ClaimPackage[];
}

/** Pay's single-batch real settle. Mirrors zk-relayer/test/
 *  e2e-scatter-direct-auth.ts steps 3–5: build merkle proof from the
 *  on-chain tree, prove off-thread in the worker, pack the
 *  AuthorizeProof tuple, and submit `scatterDirectAuth`. */
export async function realSettle(args: RealSettleArgs): Promise<RealSettleResult> {
  const {
    batch,
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    source,
    relayer,
    chain,
    maxFeeBps,
    eddsaPrivateKey,
    tree,
  } = args;
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
  // Source note must at least cover the run total. The picker enforces
  // this at the UI layer, but keep a defensive check here so a stale
  // sourcePick (e.g. note removed after the user advanced past Funds)
  // can't slip a too-small note into the proof.
  if (stored.note.amount < batch.totalAmount) {
    throw new Error(
      `Source note (${stored.note.amount}) is smaller than the run total (${batch.totalAmount}).`,
    );
  }
  // Solidity encodes maxFee as uint16 and the circuit reads it as bps;
  // clamp before proving so a stale UI input can't (a) authorize a
  // >100% fee or (b) overflow the ABI encoder.
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) {
    throw new Error(`maxFeeBps must be an integer in [0, 10000]; got ${maxFeeBps}`);
  }

  // self-pay invariant: sellToken == buyToken, sellAmount == buyAmount
  const sellAmount = batch.totalAmount;
  const buyAmount = batch.totalAmount;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const nonce = randomFieldElement();
  const newSalt = randomFieldElement();

  const result = await authorizeProver.prove({
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
  // Reconstruct the change-UTXO preimage so the caller can persist it
  // as a new vault note. Salt is the same one we passed into the
  // prover; the on-chain `newCommitment` we just verified must match
  // the locally-recomputed value (otherwise the change would be
  // unspendable). The match is implicit — `generateAuthorizeProof`
  // uses `computeCommitment` with the same fields — but recomputing
  // here gives us a CommitmentNote object the vault adapter can
  // serialize.
  const changeAmount = stored.note.amount - sellAmount;
  let change: RealSettleResult["change"] = null;
  if (changeAmount > 0n) {
    const changeNote: CommitmentNote = {
      ownerSecret: stored.note.ownerSecret,
      token: stored.note.token,
      amount: changeAmount,
      salt: newSalt,
      pubKeyAx: stored.note.pubKeyAx,
      pubKeyAy: stored.note.pubKeyAy,
    };
    const changeCommitment = await computeCommitment(changeNote);
    if (changeCommitment !== authResult.newCommitment) {
      throw new Error(
        "Recomputed change commitment does not match the proof's newCommitment — vault would store an unspendable note.",
      );
    }
    change = { note: changeNote, commitment: changeCommitment, amount: changeAmount };
  }

  // Rebuild the 16-leaf claims tree to extract per-recipient
  // inclusion proofs. `buildClaimsTree` mirrors what the authorize
  // circuit did internally; if the recomputed root disagrees with
  // the proof's `claimsRoot`, the SDK's claim-leaf hashing has
  // drifted from the circuit and the packages we emit would point
  // at a settlement that doesn't exist.
  const { root: claimsRootCheck, layers: claimsLayers } = await buildClaimsTree(batch.claims);
  if (claimsRootCheck !== authResult.claimsRoot) {
    throw new Error(
      "Recomputed claimsRoot disagrees with the proof — packages would point at a settlement that doesn't exist.",
    );
  }
  const claimsRootHex = toBytes32Hex(authResult.claimsRoot);
  const claimPackages: ClaimPackage[] = batch.claims.map((c, i) => {
    const proof = getMerkleProof(claimsLayers, i);
    return {
      version: 1,
      chainId: chain.chainId,
      settlementAddress: chain.settlementAddress,
      claimsRoot: claimsRootHex,
      recipient: ethers.getAddress(c.recipient),
      token: ethers.getAddress(tokenAddress),
      tokenSymbol,
      tokenDecimals,
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
      secret: c.secret.toString(),
      leafIndex: i,
      pathElements: proof.pathElements.map((e) => e.toString()),
      pathIndices: proof.pathIndices,
      ...(args.labels?.sender ? { senderLabel: args.labels.sender } : {}),
      ...(args.labels?.run ? { runLabel: args.labels.run } : {}),
      ...(relayer.url ? { relayerUrl: relayer.url } : {}),
    };
  });

  return {
    txHash: tx.hash,
    nullifier: authResult.nullifier,
    claimsRoot: authResult.claimsRoot,
    change,
    claimPackages,
  };
}
