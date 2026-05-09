"use client";

import { ethers } from "ethers";
import {
  COMMITMENT_POOL_ABI,
  TAG_COMMITMENT_V2,
  computeCommitment,
  computeNullifier,
  computeTokenHash,
  poseidonHash,
  randomFieldElement,
  type CommitmentNote,
} from "@zkscatter/sdk";
import type { CommitmentTreeState, VaultNote } from "@zkscatter/sdk/react";
import { getMerkleProofWithFallback } from "@zkscatter/sdk/react";

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
  if (!ethers.isAddress(recipient) || recipient === ethers.ZeroAddress) {
    throw new Error("Recipient must be a valid non-zero address.");
  }

  onPhase?.("preparing");

  // Resolve merkle path from the live tree. Live mode throws if the
  // commitment isn't reconciled, which is exactly the right behavior
  // here — we'd rather error than mint an invalid-root proof.
  const fallbackThrow = async () => {
    throw new Error(
      "Cannot resolve commitment proof — pool tree isn't ready in live mode.",
    );
  };
  const { merkleProof } = await getMerkleProofWithFallback(
    tree,
    note.commitment,
    fallbackThrow,
  );

  const tokenAddrHex = "0x" + note.note.token.toString(16).padStart(40, "0");
  const tokenHash = await computeTokenHash(tokenAddrHex);
  const nullifierHash = await computeNullifier(note.note);

  // Change-UTXO commitment: zero when the withdraw is full, else a
  // fresh `Poseidon(TAG_V2, ownerSecret, token, change, newSalt,
  // pubKeyAx, pubKeyAy)` so the residual stays spendable. Mirrors
  // the on-chain circuit's reconstruction byte-for-byte.
  const changeAmount = note.note.amount - amountRaw;
  let newCommitment = 0n;
  let newSalt = 0n;
  let changeNote: CommitmentNote | null = null;
  if (changeAmount > 0n) {
    newSalt = randomFieldElement();
    changeNote = {
      ownerSecret: note.note.ownerSecret,
      token: note.note.token,
      amount: changeAmount,
      salt: newSalt,
      pubKeyAx: note.note.pubKeyAx,
      pubKeyAy: note.note.pubKeyAy,
    };
    newCommitment = await poseidonHash([
      TAG_COMMITMENT_V2,
      changeNote.ownerSecret,
      changeNote.token,
      changeNote.amount,
      changeNote.salt,
      changeNote.pubKeyAx,
      changeNote.pubKeyAy,
    ]);
  }

  const relayer = ethers.ZeroAddress;
  const circuitInput = {
    // Public
    root: merkleProof.root.toString(),
    nullifierHash: nullifierHash.toString(),
    newCommitment: newCommitment.toString(),
    tokenHash: tokenHash.toString(),
    withdrawAmount: amountRaw.toString(),
    recipient: BigInt(recipient).toString(),
    relayer: BigInt(relayer).toString(),
    // Private
    ownerSecret: note.note.ownerSecret.toString(),
    token: note.note.token.toString(),
    amount: note.note.amount.toString(),
    salt: note.note.salt.toString(),
    newSalt: newSalt.toString(),
    pathElements: merkleProof.pathElements.map((e) => e.toString()),
    pathIndices: merkleProof.pathIndices.map((i) => i.toString()),
    pubKeyAx: note.note.pubKeyAx.toString(),
    pubKeyAy: note.note.pubKeyAy.toString(),
  };

  onPhase?.("proving");
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals: _publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    "/zk/withdraw.wasm",
    "/zk/withdraw_final.zkey",
  );

  // Solidity verifier expects each `b` row in reversed pair order —
  // mirrors the convention used by `frontend/lib/zk/prover.ts`.
  const proofA: [string, string] = [proof.pi_a[0], proof.pi_a[1]];
  const proofB: [[string, string], [string, string]] = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const proofC: [string, string] = [proof.pi_c[0], proof.pi_c[1]];

  onPhase?.("submitting");
  const pool = new ethers.Contract(commitmentPoolAddress, COMMITMENT_POOL_ABI, signer);
  const tx = (await pool.withdraw(
    proofA,
    proofB,
    proofC,
    merkleProof.root,
    nullifierHash,
    newCommitment,
    tokenAddrHex,
    amountRaw,
    recipient,
    relayer,
  )) as ethers.ContractTransactionResponse;

  onPhase?.("confirming");
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`pool.withdraw tx failed: ${tx.hash}`);
  }

  let change: SubmitWithdrawResult["change"] = null;
  if (changeNote) {
    const commitment = await computeCommitment(changeNote);
    if (commitment !== newCommitment) {
      throw new Error(
        "Recomputed change commitment doesn't match the proof's newCommitment — vault would store an unspendable note.",
      );
    }
    change = { note: changeNote, commitment, amount: changeAmount };
  }

  return { txHash: tx.hash, change };
}
