"use client";

import { ethers } from "ethers";
import { LAUNCH_TOKENS } from "@zkscatter/sdk";
import { generateNote, type CommitmentNote } from "@zkscatter/sdk/zk";
import { ensureAllowance, callDeposit } from "@zkscatter/sdk/contracts";
import type { useEdDSAKey } from "@zkscatter/sdk/react";
import { getNetworkConfig, isNetworkConfigured } from "./network";
import { depositProver } from "./depositProver";
import type { useVault } from "./vault";

export type DepositPhaseKind =
  | "preparing"
  | "approving"
  | "proving"
  | "submitting"
  | "confirming"
  | "done"
  | "error";

export interface DepositPhase {
  kind: DepositPhaseKind;
  /** Optional human-readable hint for the current phase — surfaced in
   *  the wizard's progress copy so the operator sees why a step is
   *  taking time (cold zkey fetch, MetaMask popup, etc.). */
  message?: string;
  /** Populated when `kind === "done"`. */
  txHash?: string;
  /** Populated when `kind === "error"`. */
  error?: string;
}

export interface RealDepositArgs {
  tokenSymbol: string;
  amountRaw: bigint;
  account: string | null;
  signer: ethers.Signer | null;
  eddsa: ReturnType<typeof useEdDSAKey>;
  vault: ReturnType<typeof useVault>;
  /** Reports phase transitions back to the wizard. The flow runs
   *  to completion regardless — `onPhase` is for UI only. */
  onPhase?: (phase: DepositPhase) => void;
}

export interface RealDepositResult {
  txHash: string;
  commitment: bigint;
  note: CommitmentNote;
}

/** ERC-20 → CommitmentPool deposit. Sequential flow:
 *
 *  1. Derive (or unlock cached) EdDSA keypair.
 *  2. Build a fresh `CommitmentNote` bound to that pubkey.
 *  3. Prove off-thread (deposit circuit).
 *  4. `ensureAllowance` — approve the pool to pull `amountRaw`. Skips
 *     when the existing allowance covers it; resets to 0 first when
 *     a non-zero starting allowance can't be raised cleanly (USDT-
 *     style ERC-20s).
 *  5. `callDeposit` — submit `pool.deposit(...)`, wait for receipt.
 *  6. Vault add — record the note locally with `leafIndex = -1` so
 *     the funds picker shows it as `pendingRaw` until the
 *     IncrementalMerkleTree reconciler observes the on-chain
 *     `CommitmentInserted` event and back-fills the index.
 *
 *  Native ETH (no token address) is intentionally out of scope for
 *  v1 — Pay launches with stablecoin / token pairs only. The wizard
 *  bails before this fires when `LAUNCH_TOKENS[symbol]` is missing.
 */
export async function realDeposit(args: RealDepositArgs): Promise<RealDepositResult> {
  const { tokenSymbol, amountRaw, account, signer, eddsa, vault, onPhase } = args;
  const phase = (p: DepositPhase) => onPhase?.(p);

  const cfg = getNetworkConfig();
  if (!isNetworkConfigured(cfg)) {
    throw new Error("Network not configured — set the Pay contract envs to enable deposits.");
  }
  const tokenInfo = LAUNCH_TOKENS[tokenSymbol];
  if (!tokenInfo) {
    throw new Error(`Token ${tokenSymbol} is not in LAUNCH_TOKENS — wire it before depositing.`);
  }
  if (!account) throw new Error("Connect a wallet before depositing.");
  if (!signer) throw new Error("Wallet signer not available.");
  if (amountRaw <= 0n) throw new Error("Deposit amount must be positive.");

  phase({ kind: "preparing", message: "Deriving signing key…" });
  const kp = await eddsa.derive();

  // Build the note + warm the prover in parallel — the deposit zkey
  // is ~7 MB; on a cold cache its fetch dwarfs the synchronous note
  // construction.
  const [note] = await Promise.all([
    Promise.resolve(generateNote(tokenInfo.address, amountRaw, kp.publicKey)),
    depositProver.ready(),
  ]);

  phase({ kind: "proving", message: "Generating deposit proof…" });
  const proveResult = await depositProver.prove({
    circuitId: "deposit",
    input: note as unknown as Record<string, unknown>,
  });
  if (proveResult.publicSignals.length === 0) {
    throw new Error("deposit.worker returned no public signals — circuit/wasm mismatch?");
  }
  const commitment = proveResult.publicSignals[0]!;

  phase({ kind: "approving", message: "Checking ERC-20 allowance…" });
  const allowanceTxs = await ensureAllowance(
    signer,
    tokenInfo.address,
    cfg.contracts.commitmentPool,
    amountRaw,
  );
  // Wait for every approval tx in order so the deposit submit can't
  // race the second `approve(spender, amount)` against the prior
  // `approve(spender, 0)` reset.
  for (const tx of allowanceTxs) {
    phase({ kind: "approving", message: `Waiting for approve tx ${tx.hash.slice(0, 10)}…` });
    const r = await tx.wait();
    if (!r || r.status !== 1) throw new Error(`approve tx failed: ${tx.hash}`);
  }

  phase({ kind: "submitting", message: "Sign deposit in your wallet…" });
  // The SDK helper expects `result.proof` + `result.commitment`; the
  // worker returns `{ proof, publicSignals }`, so we re-pack to match.
  const tx = await callDeposit(
    signer,
    cfg.contracts.commitmentPool,
    { proof: proveResult.proof, publicSignals: proveResult.publicSignals, commitment },
    tokenInfo.address,
    amountRaw,
  );

  phase({ kind: "confirming", message: `Waiting for ${tx.hash.slice(0, 10)}…` });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`deposit tx failed: ${tx.hash}`);
  }

  // Persist the note before reporting done — a refresh between
  // receipt and vault.add would lose the note even though the
  // commitment is on-chain. The reconciler will back-fill `leafIndex`
  // when it observes the `CommitmentInserted` event.
  await vault.add({
    symbol: tokenSymbol,
    amount: ethers.formatUnits(amountRaw, tokenInfo.decimals),
    note,
    commitment,
    txHash: tx.hash,
  });

  phase({ kind: "done", txHash: tx.hash });
  return { txHash: tx.hash, commitment, note };
}
