"use client";

import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "@zkscatter/sdk";
import {
  callClaimToPool,
  computeClaimToPoolSlicesHash,
  MAX_CLAIM_TO_POOL_SLICES,
  signClaimToPoolAuth,
  type ClaimToPoolCallInputs,
  type ClaimToPoolSlice,
} from "@zkscatter/sdk/contracts";
import type { ClaimPackage } from "@zkscatter/sdk/notes";
import {
  generateNote,
  toBytes32Hex,
  type ClaimProofInput,
  type CommitmentNote,
  type EdDSAKeyPair,
} from "@zkscatter/sdk/zk";
import type { useVault } from "./vault";
import { claimProver } from "./claimProver";
import { depositProver } from "./depositProver";

/** Phase progression the caller surfaces as a status pill. */
export type RedepositPhase =
  | "preparing"
  | "claim-proving"
  | "deposit-proving"
  | "signing"
  | "submitting"
  | "confirming";

export interface RedepositSliceSpec {
  /** Wei amount this slice carries. Must be > 0 and the sum of all
   *  specs must equal `pkg.amount`. */
  amountRaw: bigint;
}

export interface SubmitRedepositOpts {
  pkg: ClaimPackage;
  /** Stealth privkey holder — signs the EIP-712 auth that binds the
   *  slices to this claim. The contract recovers the signer and
   *  requires it to equal `pkg.recipient`. */
  stealthPrivkey: string;
  /** Connected wallet signer (typically MetaMask). Pays gas; its
   *  address is irrelevant to the contract's accounting. */
  signer: ethers.Signer;
  /** User's EdDSA keypair — every slice's commitment is bound to
   *  this pubkey so the user (the vault owner) can later spend each
   *  note. */
  eddsaKeypair: EdDSAKeyPair;
  /** Per-slice amounts. Sum must equal `pkg.amount`. */
  slices: RedepositSliceSpec[];
  /** Vault adapter for note persistence (same as realDeposit uses). */
  vault: ReturnType<typeof useVault>;
  /** Token symbol — used for the vault label only; the on-chain
   *  token address comes from `pkg.token`. */
  tokenSymbol: string;
  tokenDecimals: number;
  onPhase?: (phase: RedepositPhase, detail?: string) => void;
}

export interface SubmitRedepositResult {
  txHash: string;
  /** Notes persisted to the vault, ordered to match `slices`. */
  notes: CommitmentNote[];
}

/** Atomic stealth claim → split pool deposit pipeline.
 *
 *  Flow:
 *  1. Probe the on-chain claims group (validates `pkg`).
 *  2. Generate the claim ZK proof (recipient = stealth address).
 *  3. Generate N deposit proofs sequentially. The shared
 *     `depositProver` is a single web-worker with a FIFO queue, so
 *     even an `await Promise.all(...)` would still serialize on the
 *     worker — the for loop just makes the order deterministic and
 *     the per-slice progress copy honest.
 *  4. Sign the EIP-712 ClaimToPoolAuth with the stealth privkey,
 *     covering the slicesHash so a relayer / MEV bot cannot
 *     substitute slices.
 *  5. Send `claimToPool` via the user's wallet (gas paid by the
 *     user's main account; the stealth EOA needs no balance).
 *  6. Persist the secret notes to the vault on broadcast — same
 *     crash-safety contract as `realDeposit`. */
export async function submitRedeposit(
  opts: SubmitRedepositOpts,
): Promise<SubmitRedepositResult> {
  const {
    pkg, stealthPrivkey, signer, eddsaKeypair, slices, vault,
    tokenSymbol, tokenDecimals, onPhase,
  } = opts;

  // Mirror every contract-side guard up here so we never burn ZK
  // work on a payload that's guaranteed to revert. Each proof costs
  // ~3-5s of browser CPU, so failing fast on a bad input matters.
  if (slices.length === 0) throw new Error("redeposit: no slices");
  if (slices.length > MAX_CLAIM_TO_POOL_SLICES) {
    throw new Error(
      `redeposit: ${slices.length} slices exceeds MAX_CLAIM_TO_POOL_SLICES (${MAX_CLAIM_TO_POOL_SLICES})`,
    );
  }

  let totalRaw = 0n;
  for (let i = 0; i < slices.length; i++) {
    if (slices[i]!.amountRaw <= 0n) {
      throw new Error(`redeposit: slice ${i} amount must be > 0`);
    }
    totalRaw += slices[i]!.amountRaw;
  }
  if (totalRaw !== BigInt(pkg.amount)) {
    throw new Error(
      `redeposit: slice sum ${totalRaw} != claim amount ${pkg.amount}`,
    );
  }

  if (!signer.provider) {
    throw new Error("redeposit: signer has no provider — connect a wallet first");
  }
  if (!ethers.isAddress(pkg.settlementAddress)) {
    throw new Error(`redeposit: invalid settlement address ${pkg.settlementAddress}`);
  }
  if (!ethers.isAddress(pkg.recipient)) {
    throw new Error(`redeposit: invalid stealth recipient ${pkg.recipient}`);
  }
  if (!ethers.isAddress(pkg.token)) {
    throw new Error(`redeposit: invalid token ${pkg.token}`);
  }

  // Verify stealth privkey matches the package's recipient — catching
  // this here prevents a wasted on-chain revert.
  const stealthAddr = new ethers.Wallet(stealthPrivkey).address;
  if (stealthAddr.toLowerCase() !== pkg.recipient.toLowerCase()) {
    throw new Error(
      `redeposit: stealth privkey address ${stealthAddr} doesn't match pkg.recipient ${pkg.recipient}`,
    );
  }

  onPhase?.("preparing");
  const settlement = new ethers.Contract(
    pkg.settlementAddress,
    PRIVATE_SETTLEMENT_ABI,
    signer.provider,
  );
  const [group, network] = await Promise.all([
    settlement.claimsGroups(pkg.claimsRoot) as Promise<{
      token: string;
      totalLocked: bigint;
      totalClaimed: bigint;
      tier: bigint;
    }>,
    signer.provider.getNetwork(),
  ]);
  if (group.token === ethers.ZeroAddress) {
    throw new Error("On-chain claims group missing — settle tx may not have confirmed yet.");
  }
  if (group.token.toLowerCase() !== pkg.token.toLowerCase()) {
    throw new Error("Claim package token disagrees with on-chain group — refusing.");
  }

  // Warm both provers in parallel — they each fetch a ~7MB zkey on
  // cold start and we want the long-pole started early.
  await Promise.all([claimProver.ready(), depositProver.ready()]);

  // === Claim proof ===
  onPhase?.("claim-proving");
  const claimAmountRaw = BigInt(pkg.amount);
  const claimInput: ClaimProofInput = {
    secret: BigInt(pkg.secret),
    recipient: BigInt(pkg.recipient),
    token: BigInt(pkg.token),
    amount: claimAmountRaw,
    releaseTime: BigInt(pkg.releaseTime),
    leafIndex: pkg.leafIndex,
    merkleProof: {
      root: BigInt(pkg.claimsRoot),
      pathElements: pkg.pathElements.map((e) => BigInt(e)),
      pathIndices: pkg.pathIndices,
    },
    allClaimLeaves: [],
  };
  const claimResult = await claimProver.prove({
    circuitId: "claim",
    input: claimInput as unknown as Record<string, unknown>,
  });
  const claimMeta = claimResult.meta;
  if (
    !claimMeta ||
    typeof claimMeta.claimsRoot !== "bigint" ||
    typeof claimMeta.nullifier !== "bigint"
  ) {
    throw new Error("claim.worker returned no meta — claimsRoot/nullifier missing");
  }

  // === Deposit proofs (one per slice) ===
  onPhase?.("deposit-proving");
  const notes: CommitmentNote[] = [];
  const sliceProofs: ClaimToPoolSlice[] = [];
  for (let i = 0; i < slices.length; i++) {
    onPhase?.("deposit-proving", `${i + 1}/${slices.length}`);
    const note = generateNote(pkg.token, slices[i]!.amountRaw, eddsaKeypair.publicKey);
    notes.push(note);
    const result = await depositProver.prove({
      circuitId: "deposit",
      input: note as unknown as Record<string, unknown>,
    });
    if (result.publicSignals.length === 0) {
      throw new Error(`deposit.worker returned no public signals for slice ${i}`);
    }
    sliceProofs.push({
      proof: {
        proof: result.proof,
        publicSignals: result.publicSignals,
        commitment: result.publicSignals[0]!,
      },
      amount: slices[i]!.amountRaw,
    });
  }

  // === EIP-712 sign auth ===
  onPhase?.("signing");
  const inputs: ClaimToPoolCallInputs = {
    amount: claimAmountRaw,
    token: pkg.token,
    stealthRecipient: pkg.recipient,
    releaseTime: BigInt(pkg.releaseTime),
  };
  const slicesHash = computeClaimToPoolSlicesHash(sliceProofs);
  const claimNullifierHex = toBytes32Hex(claimMeta.nullifier);
  const stealthSig = await signClaimToPoolAuth(
    stealthPrivkey,
    network.chainId,
    pkg.settlementAddress,
    {
      claimNullifier: claimNullifierHex,
      amount: claimAmountRaw,
      token: pkg.token,
      slicesHash,
    },
  );

  // === Submit + persist ===
  onPhase?.("submitting");
  const tx = await callClaimToPool(
    signer,
    pkg.settlementAddress,
    {
      proof: claimResult.proof,
      publicSignals: claimResult.publicSignals,
      claimsRoot: claimMeta.claimsRoot,
      nullifier: claimMeta.nullifier,
    },
    inputs,
    sliceProofs,
    stealthSig,
  );

  // Persist notes BEFORE waiting for the receipt (same crash-safety
  // pattern as realDeposit). Lost secrets are unrecoverable; phantom
  // notes at leafIndex=-1 are recoverable when the reconciler picks
  // up the per-slice CommitmentInserted events.
  for (let i = 0; i < notes.length; i++) {
    await vault.add({
      symbol: tokenSymbol,
      amount: ethers.formatUnits(slices[i]!.amountRaw, tokenDecimals),
      note: notes[i]!,
      commitment: sliceProofs[i]!.proof.commitment,
      txHash: tx.hash,
    });
  }

  onPhase?.("confirming");
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`claimToPool tx failed: ${tx.hash}`);
  }

  return { txHash: tx.hash, notes };
}
