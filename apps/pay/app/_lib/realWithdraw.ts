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
  | "confirming";

export interface SubmitWithdrawArgs {
  note: VaultNote;
  /** Recipient EOA. Defaults to the connected wallet but the modal
   *  can override (e.g. operator funds a fresh address from the pool). */
  recipient: string;
  /** Amount in raw token units. When equal to `note.note.amount` the
   *  withdraw is full and no change UTXO is created. Partial-withdraw
   *  is supported by the circuit but the v1 modal locks this to the
   *  full amount — keeps the UX dead simple and avoids accidental
   *  dust commitments. */
  amountRaw: bigint;
  /** Operator's connected wallet — pays gas for the on-chain
   *  `commitmentPool.withdraw` call. */
  signer: ethers.Signer;
  commitmentPoolAddress: string;
  tree: CommitmentTreeState;
  onPhase?: (phase: WithdrawPhase) => void;
}

export interface SubmitWithdrawResult {
  txHash: string;
  /** Set when `amountRaw < note.note.amount` — the unspent residue
   *  that the caller should `vault.add` so it can be tracked in the
   *  pool balance. v1 always returns `null` (full-amount withdraws
   *  only). */
  change: { note: CommitmentNote; commitment: bigint; amount: bigint } | null;
}

/** Full / partial pool-withdraw via the `withdraw` circuit. Generates
 *  the proof in the browser (snarkjs), then calls
 *  `commitmentPool.withdraw` from the operator's connected wallet
 *  (self-pay). The relayer-paid path is not wired here — operators
 *  on the dashboard already have a connected wallet and the gas
 *  burden is one tx, so deferring relayer integration keeps the
 *  surface small. */
export async function submitWithdraw(args: SubmitWithdrawArgs): Promise<SubmitWithdrawResult> {
  const { note, recipient, amountRaw, signer, commitmentPoolAddress, tree, onPhase } = args;
  if (note.leafIndex < 0) {
    throw new Error("Note hasn't reconciled on-chain yet — wait one block then retry.");
  }
  if (amountRaw <= 0n) throw new Error("Withdraw amount must be > 0.");
  if (amountRaw > note.note.amount) {
    throw new Error("Withdraw amount exceeds the note balance.");
  }
  // v1 ships full-amount only. The change-UTXO path is correct
  // end-to-end at the proof layer (newSalt is generated and the
  // commitment round-trip-checks), but the change preimage isn't
  // persisted until *after* `tx.wait()` resolves — a crash or
  // reload between broadcast and receipt would lose the salt and
  // strand the change UTXO permanently. Lock to full-amount here
  // until we adopt the same pre-broadcast persistence pattern as
  // realDeposit.
  if (amountRaw !== note.note.amount) {
    throw new Error(
      "Partial withdraws aren't supported yet — withdraw the full note amount.",
    );
  }
  if (!ethers.isAddress(recipient) || recipient === ethers.ZeroAddress) {
    throw new Error("Recipient must be a valid non-zero address.");
  }

  onPhase?.("preparing");

  // Refuse demo-mode trees outright — `getMerkleProofWithFallback`
  // falls back to an empty-tree proof there, and a live pool would
  // reject the resulting root. The fallback callback is only reached
  // on demo, so a thrown error here is the right gate.
  if (tree.mode !== "live") {
    throw new Error("Cannot withdraw against a demo / unconnected pool.");
  }

  // Resolve merkle path + pre-compute the spend nullifier in
  // parallel. Both are circomlibjs-backed and dynamic-import
  // poseidon on cold cache — sequential chains wasted ~1 s on the
  // first withdraw of a session.
  const fallbackThrow = async (): Promise<never> => {
    throw new CommitmentProofUnavailableError(note.commitment);
  };
  const [{ merkleProof }, nullifierHash] = await Promise.all([
    getMerkleProofWithFallback(tree, note.commitment, fallbackThrow),
    computeNullifier(note.note),
  ]);

  // Pre-flight contract-side guards before the ~5–10 s prover run:
  // - `nullifiers(nullifierHash)` mirrors the on-chain double-spend
  //   check; saves prover work on a tab-double / page-refresh re-try.
  // - `isKnownRoot(merkleProof.root)` catches a tree-out-of-sync
  //   scenario (local hydrate is one block behind) so we don't burn
  //   compute on a proof the contract is going to reject.
  // The contract is the authoritative guard; these are UX
  // optimisations. Network blips fall through to the on-chain
  // submit, which reverts authoritatively.
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
        // Distinct error code so callers can branch — this often
        // means a previous withdraw succeeded on-chain but the
        // local file delete failed (e.g. File System Access
        // permission expired), so the stale note is still visible
        // in the UI. The right operator action is "reload the
        // page", not "click Refresh on the pool card".
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
      // snarkjs accepts URLs; the assets are mirrored into
      // apps/pay/public/zk by sync-zk-assets.mjs's REQUIRED list.
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

  // generateWithdrawProof already round-trip-verified the change
  // commitment against `computeCommitment` before producing the
  // proof. We trust that result here rather than re-doing the
  // poseidon work — a mismatch at this point would mean the SDK
  // produced an inconsistent result we'd be storing anyway.
  const change: SubmitWithdrawResult["change"] = changeNote
    ? {
        note: changeNote,
        commitment: proofResult.newCommitment,
        amount: note.note.amount - amountRaw,
      }
    : null;

  return { txHash: tx.hash, change };
}
