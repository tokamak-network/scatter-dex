"use client";

import { ethers } from "ethers";
import { COMMITMENT_POOL_ABI } from "@zkscatter/sdk";
import {
  computeNullifier,
  generateWithdrawProof,
  type CommitmentNote,
} from "@zkscatter/sdk/zk";
import type { CommitmentTreeState, VaultNote } from "@zkscatter/sdk/react";
import {
  CommitmentProofUnavailableError,
  getMerkleProofWithFallback,
} from "@zkscatter/sdk/react";

/** Coarse phase the modal echoes into a status banner. */
export type WithdrawPhase =
  | "preparing"
  | "proving"
  | "submitting"
  | "confirming"
  | "unwrapping";

export interface SubmitWithdrawArgs {
  note: VaultNote;
  recipient: string;
  amountRaw: bigint;
  signer: ethers.Signer;
  commitmentPoolAddress: string;
  tree: CommitmentTreeState;
  /** WETH contract address — when set + recipient equals the signer,
   *  the helper follows up with `WETH.withdraw(amount)` to release
   *  native ETH to the caller. Skipped when the token isn't WETH or
   *  the recipient is a custom address (unwrap only credits
   *  msg.sender). */
  wethAddress?: string;
  onPhase?: (phase: WithdrawPhase) => void;
}

export interface SubmitWithdrawResult {
  txHash: string;
  /** Set when amountRaw < note.note.amount. v1 = full-amount only. */
  change: { note: CommitmentNote; commitment: bigint; amount: bigint } | null;
  /** True when the helper unwrapped WETH → native ETH after the pool
   *  call (self-withdraw of a WETH note with `wethAddress` supplied). */
  unwrapped: boolean;
}

/** Full pool withdraw via the `withdraw` circuit. Ported from
 *  apps/pay/_lib/realWithdraw with the addition of optional
 *  WETH→native unwrap. */
export async function submitWithdraw(args: SubmitWithdrawArgs): Promise<SubmitWithdrawResult> {
  const {
    note,
    recipient,
    amountRaw,
    signer,
    commitmentPoolAddress,
    tree,
    wethAddress,
    onPhase,
  } = args;
  if (note.leafIndex < 0) {
    throw new Error("Note hasn't reconciled on-chain yet — wait one block then retry.");
  }
  if (amountRaw <= 0n) throw new Error("Withdraw amount must be > 0.");
  if (amountRaw > note.note.amount) {
    throw new Error("Withdraw amount exceeds the note balance.");
  }
  if (amountRaw !== note.note.amount) {
    throw new Error(
      "Partial withdraws aren't supported yet — withdraw the full note amount.",
    );
  }
  if (!ethers.isAddress(recipient) || recipient === ethers.ZeroAddress) {
    throw new Error("Recipient must be a valid non-zero address.");
  }

  onPhase?.("preparing");

  // Refuse demo-mode trees — the fallback would build an empty-tree
  // root the live pool doesn't recognise.
  if (tree.mode !== "live") {
    throw new Error("Cannot withdraw against a demo / unconnected pool.");
  }

  const fallbackThrow = async (): Promise<never> => {
    throw new CommitmentProofUnavailableError(note.commitment);
  };
  const [{ merkleProof }, nullifierHash] = await Promise.all([
    getMerkleProofWithFallback(tree, note.commitment, fallbackThrow),
    computeNullifier(note.note),
  ]);

  // Pre-flight contract-side guards. Same `nullifiers` /
  // `isKnownRoot` checks Pay uses — surfaces clear errors before the
  // prover burn.
  const readProvider = signer.provider;
  if (readProvider) {
    try {
      const pool = new ethers.Contract(
        commitmentPoolAddress,
        COMMITMENT_POOL_ABI,
        readProvider,
      );
      const [spent, knownRoot] = await Promise.all([
        pool.nullifiers(nullifierHash) as Promise<boolean>,
        pool.isKnownRoot(merkleProof.root) as Promise<boolean>,
      ]);
      if (spent) {
        const e = new Error(
          "This commitment was already withdrawn on-chain. Reload the page to drop the stale local note (your funds have already moved).",
        );
        (e as Error & { code?: string }).code = "ALREADY_WITHDRAWN";
        throw e;
      }
      if (!knownRoot) {
        throw new Error(
          "Local merkle tree is out of sync with the pool — Refresh and retry.",
        );
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      if (m.includes("already withdrawn") || m.includes("out of sync")) throw err;
      // Other errors → let the on-chain submit speak authoritatively.
    }
  }

  onPhase?.("proving");
  const tokenAddrHex = "0x" + note.note.token.toString(16).padStart(40, "0");
  const proofResult = await generateWithdrawProof(
    {
      note: note.note,
      merkleProof,
      withdrawAmount: amountRaw,
      recipient,
    },
    {
      wasm: "/zk/withdraw.wasm",
      zkey: "/zk/withdraw_final.zkey",
    },
  );
  const changeNote = proofResult.changeNote;

  onPhase?.("submitting");
  const pool = new ethers.Contract(commitmentPoolAddress, COMMITMENT_POOL_ABI, signer);
  const { proof } = proofResult;
  const tx = (await pool.withdraw(
    proof.a,
    proof.b,
    proof.c,
    proofResult.root,
    proofResult.nullifierHash,
    proofResult.newCommitment,
    tokenAddrHex,
    amountRaw,
    recipient,
    ethers.ZeroAddress,
  )) as ethers.ContractTransactionResponse;

  onPhase?.("confirming");
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`pool.withdraw tx failed: ${tx.hash}`);
  }

  // WETH unwrap is opt-in via wethAddress + recipient must equal the
  // signer (WETH.withdraw releases to msg.sender). Skip otherwise.
  let unwrapped = false;
  if (
    wethAddress &&
    tokenAddrHex.toLowerCase() === wethAddress.toLowerCase()
  ) {
    const signerAddr = await signer.getAddress();
    if (signerAddr.toLowerCase() === recipient.toLowerCase()) {
      onPhase?.("unwrapping");
      const weth = new ethers.Contract(
        wethAddress,
        ["function withdraw(uint256) external"],
        signer,
      );
      const unwrapTx = (await weth.withdraw(amountRaw)) as ethers.ContractTransactionResponse;
      const unwrapReceipt = await unwrapTx.wait();
      if (!unwrapReceipt || unwrapReceipt.status !== 1) {
        throw new Error(`WETH.withdraw unwrap failed: ${unwrapTx.hash}`);
      }
      unwrapped = true;
    }
  }

  const change: SubmitWithdrawResult["change"] = changeNote
    ? {
        note: changeNote,
        commitment: proofResult.newCommitment,
        amount: note.note.amount - amountRaw,
      }
    : null;

  return { txHash: tx.hash, change, unwrapped };
}
