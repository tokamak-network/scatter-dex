"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrders } from "../lib/orders";
import { getAuthorizeProver } from "../lib/authorizeProver";

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "proving"; message?: string }
  | { kind: "submitting" }
  | { kind: "success"; orderId: string }
  | { kind: "error"; message: string };

interface OrderModalProps {
  open: boolean;
  onClose: () => void;
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
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

export function OrderModal({
  open,
  onClose,
  side,
  pair,
  price,
  size,
}: OrderModalProps) {
  const { add: addOrder } = useOrders();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  const close = useCallback(() => {
    if (abortCtrl) abortCtrl.abort();
    setPhase({ kind: "idle" });
    setAbortCtrl(null);
    onClose();
  }, [abortCtrl, onClose]);

  const submit = useCallback(async () => {
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);
    try {
      setPhase({ kind: "preparing" });
      // Phase 3d will compose: deriveEdDSAKey on first use →
      // hashAuthorizeOrder → signEdDSA → assemble circuit input. For
      // 3c the modal exercises the surrounding UX with a small
      // delay so progress states are visible.
      await abortableSleep(300, ctrl.signal);

      setPhase({ kind: "proving", message: "Generating ZK proof…" });
      const prover = getAuthorizeProver();
      await prover.ready();
      await prover.prove(
        {
          circuitId: "authorize",
          input: { side, pair, price, size },
        },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );

      setPhase({ kind: "submitting" });
      // Phase 5+ wires relayer submission. For now just simulate
      // the latency so the flow feels coherent.
      await abortableSleep(500, ctrl.signal);

      const order = addOrder({ side, pair, price, size });
      setPhase({ kind: "success", orderId: order.label });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      console.error("[order]", e);
      setPhase({
        kind: "error",
        message: (e as Error)?.message ?? "Order failed.",
      });
    } finally {
      setAbortCtrl(null);
    }
  }, [side, pair, price, size, addOrder]);

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
      aria-labelledby="order-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 id="order-title" className="text-lg font-semibold">
            Confirm private order
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
          <strong>Demo mode</strong> — proof is generated locally with the
          mock prover, no order is submitted to a relayer. Real
          authorize circuit + relayer dispatch land in Phase 3d.
        </div>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
          <Row k="Pair" v={pair} />
          <Row k="Side" v={side === "sell" ? "Sell" : "Buy"} />
          <Row k="Price" v={price} />
          <Row k="Size" v={size} />
          <Row k="Estimated fill" v="$4,205.30" />
          <Row k="vs Uniswap" v="−0.7% slippage" />
          <Row
            k="Fee"
            v="Free (launch event until Dec 31, 2026)"
          />
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
              {/* Cancel stays enabled mid-submit — escape hatch fires
                  the AbortController which unwinds the prover and
                  the simulated submission. */}
              <button
                onClick={close}
                className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
              >
                {busy ? "Cancel" : "Close"}
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {busy ? "Working…" : "Sign & submit"}
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
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-white px-3 py-2 text-sm text-[var(--color-danger)]">
        {phase.message}
      </div>
    );
  }

  if (phase.kind === "success") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm">
        <div className="font-semibold text-[var(--color-success)]">
          Order submitted
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          {phase.orderId} is now matching against the orderbook. Open the
          Orders page to track it.
        </div>
      </div>
    );
  }

  const label =
    phase.kind === "preparing"
      ? "Preparing order…"
      : phase.kind === "proving"
      ? phase.message ?? "Generating ZK proof…"
      : "Submitting to relayer…";

  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}
