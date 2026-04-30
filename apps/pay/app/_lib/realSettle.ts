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

/** Output of {@link prepareRealSettle}: everything needed to submit
 *  the tx ({@link submitRealSettle}) and finalize on the receipt
 *  ({@link finalizeRealSettle}). Pulling these apart lets the
 *  multi-batch caller queue all proves up front and run receipt
 *  waits in parallel, while the user-sign step stays serialized for
 *  wallet UX + nonce ordering. */
export interface PreparedSettle {
  side: SettleAuthSide;
  ctx: FinalizeContext;
}

export interface FinalizeContext {
  authResult: ReturnType<typeof assembleAuthorizeProofResult>;
  /** Source note (with leafIndex + commitment); the inner
   *  `note.amount` minus `batch.totalAmount` is the change UTXO. */
  source: PickedNote["note"];
  newSalt: bigint;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  chainId: number;
  settlementAddress: string;
  batch: PayoutBatch;
  labels?: { sender?: string; run?: string };
  relayerUrl?: string;
}

/** Phase 1 — validate inputs, build the merkle proof, prove off-thread,
 *  and assemble the SettleAuthSide tuple. Pure CPU + worker time; no
 *  signer touched, no tx submitted. Concurrent calls are queued by
 *  the worker (single-threaded) but the queueing eliminates the
 *  prepare-prove latency between batches in a multi-batch run. */
export async function prepareRealSettle(args: RealSettleArgs): Promise<PreparedSettle> {
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

  const ctx: FinalizeContext = {
    authResult,
    source: stored,
    newSalt,
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    chainId: chain.chainId,
    settlementAddress: chain.settlementAddress,
    batch,
    labels: args.labels,
    relayerUrl: relayer.url,
  };
  return { side, ctx };
}

/** Phase 2 — submit `scatterDirectAuth`. Returns as soon as the wallet
 *  hands back the tx (user-sign + relayer dispatch); receipt wait is
 *  Phase 3. Caller must serialize calls with the same signer to keep
 *  the EOA's nonce monotonic. */
export async function submitRealSettle(
  prep: PreparedSettle,
  chain: { signer: ethers.Signer; settlementAddress: string },
): Promise<{ tx: ethers.TransactionResponse; ctx: FinalizeContext }> {
  const tx = await callScatterDirectAuth(chain.signer, chain.settlementAddress, prep.side, 0n);
  return { tx, ctx: prep.ctx };
}

/** Phase 3 — wait for the receipt, then reconstruct the change UTXO
 *  and the per-recipient claim packages. Safe to run for many batches
 *  in parallel; the caller is responsible for ordering vault updates
 *  by batch index so a later success can't re-spend a note an earlier
 *  failure logically forfeited. */
export async function finalizeRealSettle(
  tx: ethers.TransactionResponse,
  ctx: FinalizeContext,
): Promise<RealSettleResult> {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`scatterDirectAuth tx failed: ${tx.hash}`);
  }
  // Reconstruct the change-UTXO preimage so the caller can persist it
  // as a new vault note. The on-chain `newCommitment` we just verified
  // must match the locally-recomputed value (otherwise the change would
  // be unspendable).
  const sourceNote = ctx.source.note;
  const changeAmount = sourceNote.amount - ctx.batch.totalAmount;
  let change: RealSettleResult["change"] = null;
  if (changeAmount > 0n) {
    const changeNote: CommitmentNote = {
      ownerSecret: sourceNote.ownerSecret,
      token: sourceNote.token,
      amount: changeAmount,
      salt: ctx.newSalt,
      pubKeyAx: sourceNote.pubKeyAx,
      pubKeyAy: sourceNote.pubKeyAy,
    };
    const changeCommitment = await computeCommitment(changeNote);
    if (changeCommitment !== ctx.authResult.newCommitment) {
      throw new Error(
        "Recomputed change commitment does not match the proof's newCommitment — vault would store an unspendable note.",
      );
    }
    change = { note: changeNote, commitment: changeCommitment, amount: changeAmount };
  }

  // Rebuild the 16-leaf claims tree to extract per-recipient
  // inclusion proofs. If the recomputed root disagrees with the
  // proof's `claimsRoot`, the SDK's claim-leaf hashing has drifted
  // from the circuit and the packages we emit would point at a
  // settlement that doesn't exist.
  const { root: claimsRootCheck, layers: claimsLayers } = await buildClaimsTree(ctx.batch.claims);
  if (claimsRootCheck !== ctx.authResult.claimsRoot) {
    throw new Error(
      "Recomputed claimsRoot disagrees with the proof — packages would point at a settlement that doesn't exist.",
    );
  }
  const claimsRootHex = toBytes32Hex(ctx.authResult.claimsRoot);
  const claimPackages: ClaimPackage[] = ctx.batch.claims.map((c, i) => {
    const proof = getMerkleProof(claimsLayers, i);
    return {
      version: 1,
      chainId: ctx.chainId,
      settlementAddress: ctx.settlementAddress,
      claimsRoot: claimsRootHex,
      recipient: ethers.getAddress(c.recipient),
      token: ethers.getAddress(ctx.tokenAddress),
      tokenSymbol: ctx.tokenSymbol,
      tokenDecimals: ctx.tokenDecimals,
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
      secret: c.secret.toString(),
      leafIndex: i,
      pathElements: proof.pathElements.map((e) => e.toString()),
      pathIndices: proof.pathIndices,
      ...(ctx.labels?.sender ? { senderLabel: ctx.labels.sender } : {}),
      ...(ctx.labels?.run ? { runLabel: ctx.labels.run } : {}),
      ...(ctx.relayerUrl ? { relayerUrl: ctx.relayerUrl } : {}),
    };
  });

  return {
    txHash: tx.hash,
    nullifier: ctx.authResult.nullifier,
    claimsRoot: ctx.authResult.claimsRoot,
    change,
    claimPackages,
  };
}

/** End-to-end single-batch settle. Mirrors zk-relayer/test/
 *  e2e-scatter-direct-auth.ts steps 3–5: build merkle proof from the
 *  on-chain tree, prove off-thread in the worker, pack the
 *  AuthorizeProof tuple, submit `scatterDirectAuth`, and reconstruct
 *  the change + per-recipient claim packages. Multi-batch callers
 *  should drive {@link prepareRealSettle} / {@link submitRealSettle} /
 *  {@link finalizeRealSettle} directly so prove and receipt waits
 *  pipeline across batches. */
export async function realSettle(args: RealSettleArgs): Promise<RealSettleResult> {
  const prep = await prepareRealSettle(args);
  const { tx, ctx } = await submitRealSettle(prep, args.chain);
  return finalizeRealSettle(tx, ctx);
}
