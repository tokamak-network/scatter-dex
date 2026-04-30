"use client";

import { ethers } from "ethers";
import { COMMITMENT_POOL_IFACE, ERC20_IFACE, LAUNCH_TOKENS } from "@zkscatter/sdk";
import { generateNote, type CommitmentNote } from "@zkscatter/sdk/zk";
import {
  callDeposit,
  ensureAllowance,
  Eip5792Unsupported,
  fetchCapabilities,
  sendCalls,
  supportsAtomicBatch,
  waitForCallsReceipt,
  type SendCallsCall,
} from "@zkscatter/sdk/contracts";
import type { useEdDSAKey } from "@zkscatter/sdk/react";
import { getNetworkConfig, isNetworkConfigured } from "./network";
import { depositProver } from "./depositProver";
import type { useVault } from "./vault";

export type DepositPhaseKind =
  | "preparing"
  | "wrapping"
  | "approving"
  | "proving"
  | "submitting"
  | "confirming"
  | "done"
  | "error"
  | "cancelled";

// Minimal WETH9 surface — `deposit() payable` to wrap native ETH and
// `balanceOf` to skip the wrap when the operator already has enough
// WETH from a prior session. Inlined here rather than added to the
// SDK's ERC20_IFACE because `deposit()` collides with the
// CommitmentPool's same-named function and would confuse downstream
// readers if the two shared an interface object.
const WETH9_IFACE = new ethers.Interface([
  "function deposit() payable",
  "function balanceOf(address owner) view returns (uint256)",
]);

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
  /** Cooperative cancel. Checked at every await; on abort the flow
   *  rejects with `DepositCancelled`. The on-chain side stops at
   *  whatever the wallet had already broadcast — once a tx is in
   *  the mempool we can't recall it. */
  signal?: AbortSignal;
}

export interface RealDepositResult {
  txHash: string;
  commitment: bigint;
  note: CommitmentNote;
}

/** Thrown when the wizard cancels mid-flow. Distinct from a generic
 *  `Error` so the caller can suppress the error banner — a user-
 *  initiated cancel isn't a failure to surface. */
export class DepositCancelled extends Error {
  constructor() {
    super("Deposit cancelled");
    this.name = "DepositCancelled";
  }
}

/** Race a promise (typically `tx.wait()`) against a signal-driven
 *  rejection so a cancel during the await wins without leaving the
 *  promise dangling. The original promise itself can't be aborted —
 *  ethers v6 has no provider-level cancel — but the wizard only
 *  needs the throw to flip the UI; the underlying tx still confirms
 *  on-chain regardless. */
function raceWithAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DepositCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DepositCancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** ERC-20 (or native-ETH-via-WETH) → CommitmentPool deposit.
 *
 *  Two paths:
 *
 *  - **Atomic batch (EIP-5792).** When the wallet declares
 *    `atomicBatch.supported` for the active chain, wrap (if native
 *    + short on WETH) + approve (if allowance < amount) + deposit
 *    are bundled into a single `wallet_sendCalls` envelope —
 *    operator sees one signature prompt, gas pays one base fee.
 *    `wallet_getCallsStatus` polls for the batch receipt.
 *
 *  - **Sequential fallback.** Older wallets / unsupported chains
 *    fall through to wrap (separate tx) → approve (separate tx) →
 *    deposit (separate tx). USDT-style "must reset to 0 first"
 *    quirks are handled by `ensureAllowance`.
 *
 *  Both paths derive the EdDSA keypair, prove off-thread, persist
 *  the note speculatively *before* awaiting the final receipt
 *  (browser-crash safety: lost secrets are unrecoverable, phantom
 *  notes at leafIndex=-1 are recoverable). Both honour `signal`
 *  cooperatively at every await.
 */
export async function realDeposit(args: RealDepositArgs): Promise<RealDepositResult> {
  const { tokenSymbol, amountRaw, account, signer, eddsa, vault, onPhase, signal } = args;
  const phase = (p: DepositPhase) => onPhase?.(p);
  const checkAbort = () => {
    if (signal?.aborted) throw new DepositCancelled();
  };

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

  const erc20Address = tokenInfo.isNative ? cfg.contracts.weth : tokenInfo.address;
  if (!erc20Address || erc20Address === ethers.ZeroAddress) {
    throw new Error(
      tokenInfo.isNative
        ? "WETH address not configured — set NEXT_PUBLIC_PAY_WETH to deposit ETH."
        : `Token ${tokenSymbol} has no on-chain address.`,
    );
  }

  phase({ kind: "preparing", message: "Deriving signing key…" });
  const kp = await eddsa.derive();
  checkAbort();

  // Build the note + warm the prover in parallel — the deposit zkey
  // is ~7 MB; on a cold cache its fetch dwarfs the synchronous note
  // construction. Microtask-defer `generateNote` so `prover.ready()`
  // gets a turn first.
  const [note] = await Promise.all([
    Promise.resolve().then(() => generateNote(erc20Address, amountRaw, kp.publicKey)),
    depositProver.ready(),
  ]);
  checkAbort();

  phase({ kind: "proving", message: "Generating deposit proof…" });
  const proveResult = await depositProver.prove({
    circuitId: "deposit",
    input: note as unknown as Record<string, unknown>,
  });
  if (proveResult.publicSignals.length === 0) {
    throw new Error("deposit.worker returned no public signals — circuit/wasm mismatch?");
  }
  const commitment = proveResult.publicSignals[0]!;
  checkAbort();

  // Probe atomic-batch capability. ethers v6 BrowserProvider exposes
  // `send` directly; non-browser signers (custom JsonRpc) won't match
  // the type and we fall through to sequential.
  const provider = signer.provider;
  const browserProvider =
    provider && "send" in provider
      ? (provider as ethers.BrowserProvider)
      : null;
  let canBatch = false;
  if (browserProvider) {
    try {
      const caps = await fetchCapabilities(browserProvider, account);
      canBatch = supportsAtomicBatch(caps, cfg.chainId);
    } catch {
      // Probe failure → fall through to sequential. Real wallets that
      // don't support 5792 just return null caps; only a misbehaving
      // RPC throws here.
      canBatch = false;
    }
  }
  checkAbort();

  // Pre-compute the deposit calldata — both paths use it. The SDK
  // helper expects `result.proof` + `result.commitment`; the worker
  // returns `{ proof, publicSignals }`, so re-pack once.
  const depositCalldata = COMMITMENT_POOL_IFACE.encodeFunctionData("deposit", [
    proveResult.proof.a,
    proveResult.proof.b,
    proveResult.proof.c,
    commitment,
    erc20Address,
    amountRaw,
  ]);

  // Read existing balances/allowance in parallel — independent
  // RPC calls; the previous sequential await sat one round-trip
  // longer for no reason.
  const weth = new ethers.Contract(erc20Address, WETH9_IFACE, signer);
  const erc20Read = new ethers.Contract(erc20Address, ERC20_IFACE, signer);
  const [wethBalance, currentAllowance] = await Promise.all([
    tokenInfo.isNative
      ? (weth.balanceOf(account) as Promise<bigint>)
      : Promise.resolve(0n),
    erc20Read.allowance(account, cfg.contracts.commitmentPool) as Promise<bigint>,
  ]);
  const wrapShortfall =
    tokenInfo.isNative && wethBalance < amountRaw ? amountRaw - wethBalance : 0n;
  const needsApprove = currentAllowance < amountRaw;
  const needsZeroReset = needsApprove && currentAllowance > 0n;
  checkAbort();

  let txHash: string | undefined;

  if (canBatch && browserProvider) {
    // === Atomic batch path ===
    phase({
      kind: "submitting",
      message: "Sign one batched transaction in your wallet…",
    });
    const calls: SendCallsCall[] = [];
    if (wrapShortfall > 0n) {
      calls.push({
        to: erc20Address,
        value: ethers.toQuantity(wrapShortfall),
        data: WETH9_IFACE.encodeFunctionData("deposit", []),
      });
    }
    if (needsZeroReset) {
      calls.push({
        to: erc20Address,
        data: ERC20_IFACE.encodeFunctionData("approve", [
          cfg.contracts.commitmentPool,
          0n,
        ]),
      });
    }
    if (needsApprove) {
      calls.push({
        to: erc20Address,
        data: ERC20_IFACE.encodeFunctionData("approve", [
          cfg.contracts.commitmentPool,
          amountRaw,
        ]),
      });
    }
    calls.push({
      to: cfg.contracts.commitmentPool,
      data: depositCalldata,
    });
    try {
      const result = await sendCalls(browserProvider, {
        from: account,
        chainId: cfg.chainId,
        calls,
      });
      // Commit point: the wallet has accepted the batch. Persist the
      // note immediately, before any await that could fail, throw, or
      // be aborted. We don't have the deposit tx hash yet (the wallet
      // hasn't broadcast each call individually) — leave txHash empty
      // until waitForCallsReceipt finishes; the reconciler matches
      // notes by commitment, not txHash, so spendability isn't gated
      // on it. No `checkAbort()` between sendCalls and vault.add — a
      // late cancel here would lose secrets for an already-broadcast
      // batch.
      await vault.add({
        symbol: tokenSymbol,
        amount: ethers.formatUnits(amountRaw, tokenInfo.decimals),
        note,
        commitment,
        txHash: "",
      });
      phase({ kind: "confirming", message: "Waiting for batch confirmation…" });
      const status = await waitForCallsReceipt(browserProvider, result.id, { signal });
      // Per EIP-5792 every included tx must individually report
      // `0x1`; the last receipt corresponds to the deposit call and
      // is what we surface as the success tx.
      const receipts = status.receipts ?? [];
      if (receipts.length === 0) {
        throw new Error("Atomic batch completed but wallet returned no receipts.");
      }
      for (const r of receipts) {
        if (r.status !== "0x1") {
          throw new Error(`Atomic batch reverted on-chain (tx ${r.transactionHash})`);
        }
      }
      txHash = receipts[receipts.length - 1]!.transactionHash;
    } catch (err) {
      // Wallet method-not-found at sendCalls time despite caps probe
      // returning true — drop into sequential. Anything else is a
      // real failure (user reject, on-chain revert, timeout).
      if (err instanceof Eip5792Unsupported) {
        canBatch = false;
      } else {
        throw err;
      }
    }
  }

  if (!canBatch) {
    // === Sequential fallback ===
    if (wrapShortfall > 0n) {
      phase({
        kind: "wrapping",
        message: `Wrapping ${ethers.formatEther(wrapShortfall)} ETH → WETH…`,
      });
      const wrapTx = (await weth.deposit({
        value: wrapShortfall,
      })) as ethers.TransactionResponse;
      const wrapReceipt = await wrapTx.wait();
      if (!wrapReceipt || wrapReceipt.status !== 1) {
        throw new Error(`WETH wrap tx failed: ${wrapTx.hash}`);
      }
      checkAbort();
    }

    if (needsApprove) {
      phase({ kind: "approving", message: "Approving ERC-20 allowance…" });
      const allowanceTxs = await ensureAllowance(
        signer,
        erc20Address,
        cfg.contracts.commitmentPool,
        amountRaw,
      );
      for (const t of allowanceTxs) {
        phase({
          kind: "approving",
          message: `Waiting for approve tx ${t.hash.slice(0, 10)}…`,
        });
        const r = await t.wait();
        if (!r || r.status !== 1) throw new Error(`approve tx failed: ${t.hash}`);
        checkAbort();
      }
    }

    phase({ kind: "submitting", message: "Sign deposit in your wallet…" });
    const tx = await callDeposit(
      signer,
      cfg.contracts.commitmentPool,
      {
        proof: proveResult.proof,
        publicSignals: proveResult.publicSignals,
        commitment,
      },
      erc20Address,
      amountRaw,
    );
    txHash = tx.hash;
    // Persist BEFORE waiting for the receipt — see the safety note in
    // PR #592 review #3165458236. Crash recovery beats phantom notes.
    await vault.add({
      symbol: tokenSymbol,
      amount: ethers.formatUnits(amountRaw, tokenInfo.decimals),
      note,
      commitment,
      txHash,
    });
    phase({ kind: "confirming", message: `Waiting for ${txHash.slice(0, 10)}…` });
    // Race tx.wait against a signal-driven rejection so Cancel during
    // confirming flips the wizard to the cancelled banner without
    // waiting on the full receipt window. The note is already
    // persisted at this point, so the cancelled-state caveat ("any
    // already-broadcast tx keeps confirming on-chain") still holds.
    const receipt = await raceWithAbort(tx.wait(), signal);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`deposit tx failed: ${txHash}`);
    }
  }

  if (!txHash) {
    // Defensive: both paths set txHash. If we got here without one,
    // something went silently wrong and we'd otherwise return a
    // result with txHash="" — surface as an error instead.
    throw new Error("deposit completed without producing a tx hash");
  }

  phase({ kind: "done", txHash });
  return { txHash, commitment, note };
}
