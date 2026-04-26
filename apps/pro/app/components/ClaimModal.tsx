"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOrders, type OrderRecord } from "../lib/orders";
import { getClaimProver } from "../lib/claimProver";

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "proving"; message?: string }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

interface ClaimModalProps {
  open: boolean;
  onClose: () => void;
  order: OrderRecord | null;
}

function isAbortError(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    return e.name === "AbortError";
  }
  return (e as Error)?.name === "AbortError";
}

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

export function ClaimModal({ open, onClose, order }: ClaimModalProps) {
  const { markClaimed } = useOrders();
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

  // Esc-to-close + initial focus + focus restore (same pattern as
  // OrderModal — not a full focus trap, adequate for a confirm dialog).
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const initial = dialogRef.current?.querySelector<HTMLElement>(
      "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    initial?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [open, close]);

  const submit = useCallback(async () => {
    if (!order || !order.claim) {
      setPhase({ kind: "error", message: "This order has no claim material." });
      return;
    }

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    try {
      setPhase({ kind: "preparing" });
      // TODO: build a real ClaimProofInput once claim circuit
      // assets ship. The mock prover ignores the input shape.
      await abortableSleep(200, ctrl.signal);

      setPhase({ kind: "proving", message: "Generating ZK claim proof…" });
      const prover = getClaimProver();
      await prover.ready();
      await prover.prove(
        {
          circuitId: "claim",
          input: {
            secret: order.claim.secret.toString(),
            recipient: order.claim.recipient,
            token: order.claim.token,
            amount: order.claim.amount.toString(),
            releaseTime: order.claim.releaseTime.toString(),
            leafIndex: order.claim.leafIndex,
          },
        },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );

      setPhase({ kind: "submitting" });
      // TODO: on-chain `claim` dispatch.
      await abortableSleep(400, ctrl.signal);

      markClaimed(order.id);
      setPhase({ kind: "success" });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      console.error("[claim]", e);
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : "Claim failed.",
      });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [order, markClaimed]);

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
        aria-labelledby="claim-title"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 id="claim-title" className="text-lg font-semibold">
            Claim proceeds
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
          <strong>Demo mode</strong> — claim proof is generated locally with
          the mock prover; real on-chain claim is coming soon.
        </div>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
          <Row k="Order" v={order.label} />
          <Row k="Pair" v={order.pair} />
          <Row k="Side" v={order.side === "sell" ? "Sell" : "Buy"} />
          <Row k="Price" v={order.price} />
          <Row k="Size" v={order.size} />
          {order.claim && (
            <Row
              k="Receive"
              v={`${order.claim.amount.toString()} (raw units)`}
            />
          )}
        </dl>

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
                {busy ? "Cancel" : "Close"}
              </button>
              <button
                onClick={submit}
                disabled={busy || !order.claim}
                title={!order.claim ? "No claim material on this order" : undefined}
                className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {busy ? "Working…" : "Claim"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="py-2 text-[var(--color-text-muted)]">{k}</dt>
      <dd className="py-2 text-right font-medium">{v}</dd>
    </>
  );
}

function PhaseStatus({ phase }: { phase: Phase }) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "error") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-danger)]">
        {phase.message}
      </div>
    );
  }

  if (phase.kind === "success") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm">
        <div className="font-semibold text-[var(--color-success)]">
          Proceeds claimed
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Order is now marked as <span className="font-mono">claimed</span> in
          your history.
        </div>
      </div>
    );
  }

  const label =
    phase.kind === "preparing"
      ? "Preparing claim…"
      : phase.kind === "proving"
      ? phase.message ?? "Generating ZK claim proof…"
      : "Submitting on-chain…";

  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}
