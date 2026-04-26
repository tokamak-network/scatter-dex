"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CancelProofInput } from "@zkscatter/sdk/zk";
import { useOrders, type OrderRecord } from "../lib/orders";
import { useVault } from "../lib/vault";
import { useEdDSAKey } from "../lib/eddsaKey";
import { useRelayers } from "../lib/relayers";
import { getCancelProver } from "../lib/cancelProver";
import { buildEmptyTreeProof } from "../lib/emptyTreeProof";
import { useToast } from "./Toast";
import { PreSignPreview } from "./PreSignPreview";
import { abortableSleep, assertNotAborted, isAbortError } from "../lib/abort";

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "proving"; message?: string }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

interface Props {
  open: boolean;
  onClose: () => void;
  order: OrderRecord | null;
}

export function CancelOrderModal({ open, onClose, order }: Props) {
  const { markCancelled } = useOrders();
  const { notes } = useVault();
  const { derive: deriveEdDSA, isDeriving } = useEdDSAKey();
  const { selected: selectedRelayer } = useRelayers();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortCtrlRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const initial = dialogRef.current?.querySelector<HTMLElement>(
      "button:not([disabled])",
    );
    initial?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [open, close]);

  const submit = useCallback(async () => {
    if (!order) return;
    if (order.nonce === undefined || order.noteId === undefined) {
      setPhase({
        kind: "error",
        message:
          "This order is missing the nonce / funding-note metadata required to cancel it.",
      });
      return;
    }
    const note = notes.find((n) => n.id === order.noteId);
    if (!note) {
      setPhase({
        kind: "error",
        message:
          "The note that funded this order is no longer in the vault — cancel cannot proceed.",
      });
      return;
    }
    // Cancel proof signs `Poseidon(nonceNullifier, relayer)` so the
    // cancel-tx submitter is bound. Refuse to prove without a real
    // relayer — a ZeroAddress fallback would produce a 1–2 s desktop
    // / 5–9 s mobile proof that can never be settled.
    if (!selectedRelayer) {
      setPhase({
        kind: "error",
        message:
          "Choose an online relayer before cancelling — the cancel proof binds the submitter.",
      });
      return;
    }
    const relayerAddr = selectedRelayer.address;

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    try {
      setPhase({ kind: "preparing" });
      const eddsaKey = await deriveEdDSA();
      assertNotAborted(ctrl.signal);

      // Empty-tree merkle proof — same demo shortcut as OrderModal.
      // Real proof against the on-chain pool root lands with the
      // incremental-tree migration.
      const { merkleProof } = await buildEmptyTreeProof(note.note);
      assertNotAborted(ctrl.signal);

      const input: CancelProofInput = {
        note: note.note,
        leafIndex: 0,
        merkleProof,
        nonce: order.nonce,
        eddsaPrivateKey: eddsaKey.privateKey,
        relayer: relayerAddr,
      };

      setPhase({ kind: "proving", message: "Generating ZK cancel proof…" });
      const prover = getCancelProver();
      await prover.ready();
      await prover.prove(
        { circuitId: "cancel", input: input as unknown as Record<string, unknown> },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );

      setPhase({ kind: "submitting" });
      // Phase 5+ wires CommitmentPool.cancelPrivate(...) — this sleep
      // stands in until the contracts module gains the helper.
      await abortableSleep(400, ctrl.signal);

      markCancelled(order.id);
      setPhase({ kind: "success" });
      toast.push({
        kind: "success",
        title: `${order.label} cancelled`,
        description: "Funds rotated to a fresh commitment in your vault.",
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      const msg = e instanceof Error ? e.message : "Cancel failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Cancel failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [order, notes, selectedRelayer, deriveEdDSA, markCancelled, toast]);

  if (!open || !order) return null;

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="cancel-title" className="text-lg font-semibold">
            Cancel order
          </h2>
          <button
            onClick={close}
            className="rounded p-1 text-[var(--color-text-subtle)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <PreSignPreview
          primary={[
            { label: "Order", value: order.label },
            { label: "Side", value: order.side === "sell" ? "Sell" : "Buy" },
          ]}
          secondary={[
            { label: "Pair", value: order.pair },
            { label: "Price", value: order.price },
            { label: "Size", value: order.size },
            { label: "Cancel fee", value: "0", highlight: true },
          ]}
          footer="Cancellation publishes the order's nonce nullifier and rotates the escrow to a fresh commitment. The order can never be matched after this — funds stay in your vault."
        />

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
              <button
                onClick={close}
                className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
              >
                {busy ? "Cancel" : "Keep order"}
              </button>
              <button
                onClick={submit}
                disabled={busy || isDeriving}
                title={isDeriving ? "Awaiting wallet signature…" : undefined}
                className="rounded-md bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                {busy
                  ? "Working…"
                  : isDeriving
                  ? "Awaiting signature…"
                  : "Cancel order"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PhaseStatus({ phase }: { phase: Phase }) {
  if (phase.kind === "idle" || phase.kind === "success") return null;

  if (phase.kind === "error") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-white px-3 py-2 text-sm text-[var(--color-danger)]">
        {phase.message}
      </div>
    );
  }

  const label =
    phase.kind === "preparing"
      ? "Preparing cancel…"
      : phase.kind === "proving"
      ? phase.message ?? "Generating ZK cancel proof…"
      : "Publishing nullifier…";
  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}
