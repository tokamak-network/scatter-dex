"use client";

import { useCallback, useEffect, useState } from "react";
import {
  computeCommitment,
  generateNote,
  toBytes32Hex,
  type CommitmentNote,
} from "@zkscatter/sdk/zk";
import { useWallet } from "@zkscatter/sdk/react";
import { useVault } from "../lib/vault";
import { useEdDSAKey } from "../lib/eddsaKey";
import { getDepositProver } from "../lib/depositProver";
import { parseUnits } from "../lib/parseUnits";
import { useToast } from "./Toast";

const DEMO_TOKENS = [
  { symbol: "ETH", address: "0x0000000000000000000000000000000000000001", decimals: 18 },
  { symbol: "USDC", address: "0x0000000000000000000000000000000000000002", decimals: 6 },
  { symbol: "WBTC", address: "0x0000000000000000000000000000000000000003", decimals: 8 },
];

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
}

/** Was the error a cancellation (AbortSignal triggered)? Checks
 *  by exception type / name rather than message string — the
 *  message text isn't a stable contract across DOMException
 *  implementations. */
function isAbortError(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    return e.name === "AbortError";
  }
  return (e as Error)?.name === "AbortError";
}

/** Sleep that honors an AbortSignal — rejects with AbortError when
 *  the signal fires, instead of resolving and letting the caller
 *  silently mutate state after a cancel. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function DepositModal({ open, onClose }: DepositModalProps) {
  const { add: addNote } = useVault();
  const { account } = useWallet();
  const { derive: deriveEdDSA, isDeriving } = useEdDSAKey();
  const toast = useToast();
  const [tokenSymbol, setTokenSymbol] = useState("ETH");
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
    const token = DEMO_TOKENS.find((t) => t.symbol === tokenSymbol);
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
      const commitment = await computeCommitment(note);
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      setPhase({ kind: "proving", message: "Generating ZK proof…" });
      const prover = getDepositProver();
      await prover.ready();
      await prover.prove(
        {
          circuitId: "deposit",
          input: {
            commitment: commitment.toString(),
            token: note.token.toString(),
            amount: note.amount.toString(),
            secret: note.ownerSecret.toString(),
            salt: note.salt.toString(),
            pubKeyAx: note.pubKeyAx.toString(),
            pubKeyAy: note.pubKeyAy.toString(),
          },
        },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );

      setPhase({ kind: "submitting" });
      // Phase 5+ wires CommitmentPool.deposit(); the abortable
      // sleep stands in for it now and respects cancel.
      await abortableSleep(600, ctrl.signal);

      addNote({
        symbol: token.symbol,
        amount,
        note,
        commitment,
      });
      setPhase({ kind: "success", commitment });
      toast.push({
        kind: "success",
        title: `Deposited ${amount} ${token.symbol}`,
        description: "Note added to your private vault.",
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
  }, [tokenSymbol, amount, account, deriveEdDSA, addNote, toast]);

  if (!open) return null;

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 id="deposit-title" className="text-lg font-semibold">
            Deposit to vault
          </h2>
          <button
            onClick={close}
            className="rounded p-1 text-[var(--color-text-subtle)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="mb-4 rounded-md border border-[var(--color-warning-soft)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          <strong>Demo mode</strong> — proofs are generated locally with the
          mock prover, no on-chain transaction is sent. Real deposit circuit
          + contract call land in Phase 2b-iii.
        </div>

        <fieldset disabled={busy} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">
              Token
            </span>
            <select
              value={tokenSymbol}
              onChange={(e) => setTokenSymbol(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
            >
              {DEMO_TOKENS.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">
              Amount
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono"
              placeholder="0.0"
            />
          </label>
        </fieldset>

        <PhaseStatus phase={phase} />

        <div className="mt-5 flex justify-end gap-2">
          {phase.kind === "success" ? (
            <button
              onClick={close}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              Done
            </button>
          ) : (
            <>
              {/* Cancel must stay enabled even mid-submit — that's
                  the whole point of an escape hatch. The handler
                  fires the AbortController so the prover and the
                  pseudo-submit step both unwind cleanly. */}
              <button
                onClick={close}
                className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
              >
                {busy ? "Cancel" : "Close"}
              </button>
              <button
                onClick={submit}
                disabled={busy || isDeriving || !account}
                title={!account ? "Connect a wallet first" : undefined}
                className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {busy ? "Working…" : isDeriving ? "Awaiting signature…" : "Deposit"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
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
