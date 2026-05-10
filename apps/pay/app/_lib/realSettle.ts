"use client";

import { ethers } from "ethers";
import {
  assembleAuthorizeProofResult,
  buildClaimsTree,
  computeCommitment,
  getMerkleProof,
  randomFieldElement,
  toBytes32Hex,
  type CommitmentNote,
  type PayoutBatch,
} from "@zkscatter/sdk/zk";
import { type SettleAuthSide } from "@zkscatter/sdk/contracts";
import { RelayerClient, type AuthorizeOrderBody, type RelayerInfo } from "@zkscatter/sdk/relayer";
import type { ClaimPackage } from "@zkscatter/sdk/notes";
import { authorizeProver } from "./authorizeProver";
import type { CommitmentTreeState } from "./commitmentTree";
import { BPS_DENOMINATOR } from "./payoutFees";
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
  /** Exact fee the relayer will charge for this batch in token-raw
   *  units (`serviceFee + per-batch claim reserve`). Threaded from the
   *  caller so the proof's `sellAmount` matches the on-chain charge
   *  (`fee = sellAmount − totalLocked`) exactly — no `ceil(maxFeeBps)`
   *  over-collection. Must satisfy `feeRaw × 10000 ≤ sellAmount ×
   *  maxFeeBps` (validated below). */
  feeRaw: bigint;
  eddsaPrivateKey: Uint8Array;
  /** Public key matching `eddsaPrivateKey` (BabyJub `[ax, ay]`).
   *  Surfaced to the wire body so the relayer can re-verify the
   *  proof's `pubKeyBind` without rederiving from the secret. */
  eddsaPublicKey: readonly [bigint, bigint];
  tree: CommitmentTreeState;
  /** Optional sender / run labels echoed into each ClaimPackage so
   *  recipients see who sent it and which run it belongs to. */
  labels?: { sender?: string; run?: string };
  /** Lower-cased stealth address → ephemeral pubkey, produced by
   *  `applyStealthRouting`. When a claim's recipient lookup hits this
   *  map the package gains the EIP-5564 ephPub field so the receiver
   *  can derive the matching stealth privkey locally. */
  ephPubByAddress?: Record<string, string>;
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
  /** Token-units (raw bigint, formatted at the call site). The fee
   *  the relayer actually charged for this batch — equals
   *  `sellAmount − totalLocked` from the authorize proof. Surface in
   *  the operator's RunRecord so the detail page can show it. */
  relayerFee: bigint;
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
   *  `note.amount` minus `sellAmount` is the change UTXO. */
  source: PickedNote["note"];
  /** Bonded into the authorize proof — the circuit emits the change
   *  commitment as `note.amount - sellAmount`, so finalize must
   *  rebuild the same value or the change UTXO will be unspendable. */
  sellAmount: bigint;
  newSalt: bigint;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  chainId: number;
  settlementAddress: string;
  batch: PayoutBatch;
  labels?: { sender?: string; run?: string };
  relayerUrl?: string;
  ephPubByAddress?: Record<string, string>;
  /** EdDSA pubkey the proof was bound to (Poseidon(ax, ay) == pubKeyBind).
   *  Submitted alongside the proof so the relayer can revalidate the
   *  bind without re-deriving from the private key. */
  pubKey: { ax: bigint; ay: bigint };
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
    eddsaPublicKey,
    chain,
    maxFeeBps,
    feeRaw,
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
  // Solidity encodes maxFee as uint16 and the circuit reads it as bps;
  // clamp before proving so a stale UI input can't (a) authorize a
  // >100% fee or (b) overflow the ABI encoder.
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) {
    throw new Error(`maxFeeBps must be an integer in [0, 10000]; got ${maxFeeBps}`);
  }

  // sellAmount = totalLocked + feeRaw. `feeRaw` is the caller-composed
  // exact fee (service + claim reserve); re-deriving it from
  // `maxFeeBps` here would round up to the next bps boundary and
  // over-collect (e.g. 3.05 USDC → 3.20 USDC at 32 bps). The
  // contract still enforces `fee × 10000 ≤ sellAmount × maxFee`;
  // catch a mismatched caller before wasting a ~5 s proof.
  const sellAmount = batch.totalAmount + feeRaw;
  if (feeRaw * BPS_DENOMINATOR > sellAmount * BigInt(maxFeeBps)) {
    throw new Error(
      `feeRaw=${feeRaw} exceeds bps cap (sellAmount=${sellAmount}, maxFeeBps=${maxFeeBps})`,
    );
  }
  const buyAmount = sellAmount;
  if (stored.note.amount < sellAmount) {
    throw new Error(
      `Source note (${stored.note.amount}) is smaller than sell amount (${sellAmount}).`,
    );
  }
  // Settle must land before the earliest releaseTime — claim leaves
  // become valid then. `block.timestamp > expiry` reverts OrderExpired.
  const minReleaseTime = batch.claims.reduce(
    (m, c) => (c.releaseTime < m ? c.releaseTime : m),
    batch.claims[0]!.releaseTime,
  );
  const expiry = minReleaseTime;
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
    tier: batch.tier,
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
    tier: batch.tier.cap,
  };

  const ctx: FinalizeContext = {
    authResult,
    source: stored,
    sellAmount,
    newSalt,
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    chainId: chain.chainId,
    settlementAddress: chain.settlementAddress,
    batch,
    labels: args.labels,
    relayerUrl: relayer.url,
    ephPubByAddress: args.ephPubByAddress,
    pubKey: { ax: eddsaPublicKey[0], ay: eddsaPublicKey[1] },
  };
  return { side, ctx };
}

/** Phase 2 — submit `scatterDirectAuth`. Returns as soon as the wallet
 *  hands back the tx (user-sign + relayer dispatch); receipt wait is
 *  Phase 3. Caller must serialize calls with the same signer to keep
 *  the EOA's nonce monotonic. The settlement address comes from the
 *  prepared context — submitting against a different address would
 *  point at a settlement the proof's commitments don't apply to. */
/** Result of {@link submitRealSettle} — the relayer-dispatched path
 *  no longer hands back a wallet `TransactionResponse`. The wizard
 *  only needs the tx hash + the receipt to extract events, both of
 *  which we surface here. */
export interface SubmittedSettle {
  txHash: string;
  ctx: FinalizeContext;
}

/** Phase 2 — submit the prepared proof to the chosen relayer's
 *  `/api/authorize-orders` endpoint and poll until it dispatches
 *  the `scatterDirectAuth` tx. The relayer is the contract-side
 *  caller (`msg.sender == side.relayer`); the operator's wallet
 *  is never used to send the settle tx, only to EdDSA-sign the
 *  authorize proof inside `prepareRealSettle`.
 *
 *  The poll loop keeps trying until either `settleTxHash` lands or
 *  the relayer reports a terminal `failed` status — `pending` /
 *  `matched` / `submitted` are intermediate. */
export async function submitRealSettle(
  prep: PreparedSettle,
  relayerUrl: string,
  options: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SubmittedSettle> {
  const { pollIntervalMs = 1500, timeoutMs = 120_000, signal } = options;
  const body = buildAuthorizeOrderBody(prep);
  const client = new RelayerClient(relayerUrl);
  const initial = await client.submitAuthorizeOrder(body, signal);
  if (initial.status === "failed") {
    throw new Error(initial.error ?? "Relayer rejected the authorize order");
  }
  const nullifier = initial.nullifier ?? body.publicSignals.nullifier;
  if (initial.settleTxHash) {
    return { txHash: initial.settleTxHash, ctx: prep.ctx };
  }
  const deadline = Date.now() + timeoutMs;
  // Bounded poll — relayer dispatch usually lands within a couple of
  // seconds on a healthy stack; the longer ceiling absorbs blocked
  // mempools. `signal` from the caller fast-paths cancellation.
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("submitRealSettle aborted by caller");
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const status = await client.pollAuthorizeOrder(nullifier, signal);
    if (status.settleTxHash) {
      return { txHash: status.settleTxHash, ctx: prep.ctx };
    }
    if (status.status === "failed") {
      throw new Error(status.error ?? "Relayer dispatch failed");
    }
  }
  throw new Error(
    `Relayer did not dispatch within ${Math.round(timeoutMs / 1000)}s — order ${nullifier} is still ${initial.status}`,
  );
}

/** Build the wire body the relayer's `POST /api/authorize-orders`
 *  endpoint expects. The named `publicSignals` view mirrors the
 *  zero-indexed `publicSignalsArray` so a server-side replay can
 *  re-derive every field without re-deriving from circom. */
function buildAuthorizeOrderBody(prep: PreparedSettle): AuthorizeOrderBody {
  const { authResult } = prep.ctx;
  const ar = authResult.publicSignals;
  // Position-based mapping mirrors authorize.circom's public-signal
  // ordering (see the named result fields on AuthorizeProofResult);
  // the relayer reads both shapes as a defence-in-depth check.
  return {
    proof: {
      a: [authResult.proof.a[0].toString(), authResult.proof.a[1].toString()],
      b: [
        [authResult.proof.b[0][0].toString(), authResult.proof.b[0][1].toString()],
        [authResult.proof.b[1][0].toString(), authResult.proof.b[1][1].toString()],
      ],
      c: [authResult.proof.c[0].toString(), authResult.proof.c[1].toString()],
    },
    publicSignals: {
      pubKeyBind: ar[0]!.toString(),
      commitmentRoot: ar[1]!.toString(),
      nullifier: ar[2]!.toString(),
      nonceNullifier: ar[3]!.toString(),
      newCommitment: ar[4]!.toString(),
      sellToken: ar[5]!.toString(),
      buyToken: ar[6]!.toString(),
      sellAmount: ar[7]!.toString(),
      buyAmount: ar[8]!.toString(),
      maxFee: ar[9]!.toString(),
      expiry: ar[10]!.toString(),
      claimsRoot: ar[11]!.toString(),
      totalLocked: ar[12]!.toString(),
      relayer: ar[13]!.toString(),
      orderHash: ar[14]!.toString(),
    },
    publicSignalsArray: ar.map((s) => s.toString()),
    tier: prep.side.tier,
    pubKeyAx: prep.ctx.pubKey.ax.toString(),
    pubKeyAy: prep.ctx.pubKey.ay.toString(),
  };
}

/** Phase 3 — wait for the receipt, then reconstruct the change UTXO
 *  and the per-recipient claim packages. Safe to run for many batches
 *  in parallel; the caller is responsible for ordering vault updates
 *  by batch index so a later success can't re-spend a note an earlier
 *  failure logically forfeited.
 *
 *  Now reads the receipt from the chain via the supplied provider —
 *  the relayer-dispatch path doesn't hand back a wallet
 *  `TransactionResponse`, only the tx hash. */
export async function finalizeRealSettle(
  txHash: string,
  ctx: FinalizeContext,
  provider: ethers.Provider,
): Promise<RealSettleResult> {
  const receipt = await provider.waitForTransaction(txHash);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`scatterDirectAuth tx failed: ${txHash}`);
  }
  // Reconstruct the change-UTXO preimage so the caller can persist it
  // as a new vault note. The on-chain `newCommitment` we just verified
  // must match the locally-recomputed value (otherwise the change would
  // be unspendable).
  const sourceNote = ctx.source.note;
  const changeAmount = sourceNote.amount - ctx.sellAmount;
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

  // Rebuild the claims tree (size = 2^batch.tier.claimsTreeDepth) to
  // extract per-recipient inclusion proofs. If the recomputed root
  // disagrees with the proof's `claimsRoot`, the SDK's claim-leaf
  // hashing has drifted from the circuit and the packages we emit
  // would point at a settlement that doesn't exist.
  const { root: claimsRootCheck, layers: claimsLayers } = await buildClaimsTree(
    ctx.batch.claims,
    ctx.batch.tier,
  );
  if (claimsRootCheck !== ctx.authResult.claimsRoot) {
    throw new Error(
      "Recomputed claimsRoot disagrees with the proof — packages would point at a settlement that doesn't exist.",
    );
  }
  const claimsRootHex = toBytes32Hex(ctx.authResult.claimsRoot);
  const claimPackages: ClaimPackage[] = ctx.batch.claims.map((c, i) => {
    const proof = getMerkleProof(claimsLayers, i);
    const ephPub = ctx.ephPubByAddress?.[c.recipient.toLowerCase()];
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
      ...(ephPub ? { ephemeralPubKey: ephPub } : {}),
    };
  });

  const relayerFee = ctx.sellAmount > ctx.batch.totalAmount
    ? ctx.sellAmount - ctx.batch.totalAmount
    : 0n;
  return {
    txHash,
    nullifier: ctx.authResult.nullifier,
    claimsRoot: ctx.authResult.claimsRoot,
    change,
    claimPackages,
    relayerFee,
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
  const { txHash, ctx } = await submitRealSettle(prep, args.relayer.url);
  const provider = args.chain.signer.provider;
  if (!provider) {
    throw new Error("realSettle: signer has no provider for receipt poll");
  }
  return finalizeRealSettle(txHash, ctx, provider);
}
