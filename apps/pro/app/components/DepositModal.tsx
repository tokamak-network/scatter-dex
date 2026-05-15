"use client";

import { useCallback, useEffect, useState } from "react";
import {
  generateNote,
  toBytes32Hex,
  type CommitmentNote,
} from "@zkscatter/sdk/zk";
import type { DepositProofResult } from "@zkscatter/sdk/zk";
import { useWallet } from "@zkscatter/sdk/react";
import { useIdentityGate } from "../lib/identity";
import { IdentityGateModal } from "./IdentityGateModal";
import { useVault } from "../lib/vault";
import { useEdDSAKey } from "@zkscatter/sdk/react";
import { depositProver } from "../lib/depositProver";
import { parseUnits } from "../lib/parseUnits";
import { DEMO_NETWORK } from "../lib/network";
import { dispatchDeposit } from "../lib/dispatch";
import { Button, Field, Modal, useToast } from "@zkscatter/ui";
import { TestnetNotice } from "./TestnetNotice";
import { isAbortError } from "../lib/abort";

// Depositable tokens are the full LAUNCH_TOKENS lineup —
// ETH / USDC / USDT / TON — every entry on the SDK's UI whitelist.
// We show all of them so the user sees the supported set even when
// a particular deploy hasn't wired one yet; the entry is marked
// "(not deployed)" and the Deposit button stays disabled in that
// case. Source of truth: `DEMO_NETWORK.tokens` after the env
// overlay applies. Submit-time `dispatchDeposit` still guards
// against ZERO_ADDRESS tokens as a defense in depth.
const ZERO = "0x0000000000000000000000000000000000000000";
const DEPOSITABLE = DEMO_NETWORK.tokens;
function isConfigured(addr: string): boolean {
  return addr.toLowerCase() !== ZERO;
}

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "proving"; message?: string }
  | { kind: "submitting" }
  | { kind: "success"; commitment: bigint }
  | { kind: "error"; message: string };

interface DepositModalProps {
  open: boolean;
  onClose: () => void;
  /** Token symbol to pre-select when the modal opens. Lets context-aware
   *  callers (e.g. NoteSelect's "+ Deposit USDC" button while the order
   *  form is on Buy ETH = fund-with-USDC) land on the right token
   *  without the user having to flip the selector. Generic callers
   *  (the left-panel "+ Deposit" CTA) leave this undefined and keep
   *  the historical ETH default. */
  initialTokenSymbol?: string;
}

export function DepositModal({ open, onClose, initialTokenSymbol }: DepositModalProps) {
  const { state: identityState, blocking: identityBlocking } = useIdentityGate();

  const { add: addNote } = useVault();
  const { account, signer } = useWallet();
  const { derive: deriveEdDSA, isDeriving } = useEdDSAKey();
  const toast = useToast();
  const [tokenSymbol, setTokenSymbol] = useState(initialTokenSymbol ?? "ETH");

  // Reset the selector to the caller's preferred token every time the
  // modal re-opens. Without this the modal keeps the previous session's
  // choice across reopens (the component instance is page-level —
  // shared between the generic left-panel CTA and the per-order-side
  // NoteSelect inline button), so a "Buy ETH → + Deposit USDC" click
  // would silently land on whatever token the user picked last time.
  useEffect(() => {
    if (open && initialTokenSymbol) {
      setTokenSymbol(initialTokenSymbol);
    }
  }, [open, initialTokenSymbol]);
  const [amount, setAmount] = useState("1.0");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setAmount("1.0");
    setTokenSymbol("ETH");
    setAbortCtrl(null);
  }, []);

  // Reset to idle whenever the modal opens fresh.
  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  const close = useCallback(() => {
    if (abortCtrl) abortCtrl.abort();
    reset();
    onClose();
  }, [abortCtrl, reset, onClose]);

  const submit = useCallback(async () => {
    const token = DEPOSITABLE.find((t) => t.symbol === tokenSymbol);
    if (!token) return;
    if (!account) {
      setPhase({
        kind: "error",
        message: "Connect a wallet before depositing.",
      });
      return;
    }

    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount, token.decimals);
    } catch (e) {
      setPhase({
        kind: "error",
        message: (e as Error)?.message ?? "Invalid amount.",
      });
      return;
    }
    if (amountWei <= 0n) {
      setPhase({ kind: "error", message: "Enter a positive amount." });
      return;
    }

    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    try {
      setPhase({ kind: "preparing" });
      // Derive (or retrieve cached) EdDSA keypair via the wallet.
      // First call prompts the wallet for a signature; later calls
      // in the same session resolve from cache.
      const eddsaKey = await deriveEdDSA();
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const note: CommitmentNote = generateNote(
        token.address,
        amountWei,
        eddsaKey.publicKey,
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      setPhase({ kind: "proving", message: "Generating ZK proof…" });
      await depositProver.ready();
      // Pass the BigInt CommitmentNote directly — structured-clone
      // supports BigInt natively. `generateDepositProof` derives the
      // commitment internally and returns it as `publicSignals[0]`,
      // so we read it from the prove result instead of running a
      // second `computeCommitment` on the main thread (which would
      // boot circomlibjs's Poseidon tables a second time).
      const proveResult = await depositProver.prove(
        {
          circuitId: "deposit",
          input: note as unknown as Record<string, unknown>,
        },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );
      if (proveResult.publicSignals.length === 0) {
        throw new Error("deposit prove returned no public signals");
      }
      const commitment = proveResult.publicSignals[0]!;

      setPhase({ kind: "submitting" });
      // The prove result carries snarkjs's raw-shaped proof; the
      // dispatch layer expects the SDK's `DepositProofResult` shape
      // (commitment + Groth16Proof tuples). Reconstruct it from
      // `proveResult` — the prover already formatted the proof in
      // the right shape, so this is purely a re-pack.
      const depositProof: DepositProofResult = {
        commitment,
        proof: proveResult.proof,
        publicSignals: proveResult.publicSignals,
      };
      const dispatch = await dispatchDeposit(
        signer,
        depositProof,
        token.address,
        amountWei,
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      await addNote({
        symbol: token.symbol,
        amount,
        note,
        commitment,
      });
      setPhase({ kind: "success", commitment });
      const description =
        dispatch.kind === "onchain"
          ? `On-chain tx ${dispatch.txHash.slice(0, 10)}… · note added to your private vault.`
          : "Note added to your private vault (simulated — pool not configured).";
      toast.push({
        kind: "success",
        title: `Deposited ${amount} ${token.symbol}`,
        description,
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) {
        return;
      }
      console.error("[deposit]", e);
      const msg = (e as Error)?.message ?? "Deposit failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Deposit failed", description: msg });
    } finally {
      setAbortCtrl(null);
    }
  }, [tokenSymbol, amount, account, signer, deriveEdDSA, addNote, toast]);

  if (!open) return null;

  // Identity gate — when the wallet's verification status is
  // unverified / expired / error, show the gate prompt in place
  // of the deposit content. Mirrors Pay's NewPayoutGate pattern.
  if (identityBlocking) {
    return <IdentityGateModal state={identityState} onClose={close} />;
  }

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <Modal open={open} onClose={close} title="Deposit to vault">
      <TestnetNotice />
      <fieldset disabled={busy} className="space-y-4">
        <Field label="Token">
          <select
            value={tokenSymbol}
            onChange={(e) => setTokenSymbol(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
          >
            {DEPOSITABLE.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
                {isConfigured(t.address) ? "" : " (not deployed)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono"
            placeholder="0.0"
          />
        </Field>
      </fieldset>

      <PhaseStatus phase={phase} />

      <div className="mt-5 flex justify-end gap-2">
        {phase.kind === "success" ? (
          <Button onClick={close} size="lg">
            Done
          </Button>
        ) : (
          <>
            {/* Cancel must stay enabled even mid-submit — that's the
                whole point of an escape hatch. The handler fires the
                AbortController so the prover and the pseudo-submit
                step both unwind cleanly. */}
            <Button variant="secondary" onClick={close}>
              {busy ? "Cancel" : "Close"}
            </Button>
            {(() => {
              // Gate the Deposit button when the chosen token isn't
              // wired up for the active network. Without this the
              // submit kicks off a 1–2 s prove only to fail at
              // `dispatchDeposit`'s zero-address guard.
              const picked = DEPOSITABLE.find((t) => t.symbol === tokenSymbol);
              const tokenConfigured = picked ? isConfigured(picked.address) : false;
              const disableReason = !account
                ? "Connect a wallet first"
                : !tokenConfigured
                  ? `${tokenSymbol} isn't deployed on this network yet`
                  : undefined;
              return (
                <Button
                  onClick={submit}
                  disabled={busy || isDeriving || !account || !tokenConfigured}
                  title={disableReason}
                >
                  {busy ? "Working…" : isDeriving ? "Awaiting signature…" : "Deposit"}
                </Button>
              );
            })()}
          </>
        )}
      </div>
    </Modal>
  );
}

function PhaseStatus({ phase }: { phase: Phase }) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "error") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-white px-3 py-2 text-sm text-[var(--color-danger)]">
        {phase.message}
      </div>
    );
  }

  if (phase.kind === "success") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm">
        <div className="font-semibold text-[var(--color-success)]">
          Deposit complete
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Commitment{" "}
          <span className="font-mono">
            {toBytes32Hex(phase.commitment).slice(0, 12)}…
            {toBytes32Hex(phase.commitment).slice(-6)}
          </span>{" "}
          added to your vault.
        </div>
      </div>
    );
  }

  const label =
    phase.kind === "preparing"
      ? "Preparing note…"
      : phase.kind === "proving"
      ? phase.message ?? "Generating ZK proof…"
      : "Submitting to chain…";

  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}
