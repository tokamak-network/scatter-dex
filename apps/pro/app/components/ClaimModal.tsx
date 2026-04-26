"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, useToast } from "@zkscatter/ui";
import { useOrders, type OrderRecord } from "../lib/orders";
import { getClaimProver } from "../lib/claimProver";
import { abortableSleep, isAbortError } from "../lib/abort";

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

export function ClaimModal({ open, onClose, order }: ClaimModalProps) {
  const { markClaimed } = useOrders();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

  const submit = useCallback(async () => {
    if (!order || !order.claim) {
      setPhase({ kind: "error", message: "This order has no claim material." });
      return;
    }

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    try {
      setPhase({ kind: "preparing" });

      // The order stored a single claim entry. We send the
      // BigInt-backed `entry` + `leafIndex` to the worker; the
      // worker rebuilds the matching 16-leaf claims tree there so
      // circomlibjs's Poseidon init never boots on the UI thread.
      // When real settled orders arrive from chain events, a pre-
      // derived `merkleProof` from the indexer replaces this.
      const entry = {
        secret: order.claim.secret,
        recipient: BigInt(order.claim.recipient),
        token: BigInt(order.claim.token),
        amount: order.claim.amount,
        releaseTime: order.claim.releaseTime,
      };

      setPhase({ kind: "proving", message: "Generating ZK claim proof…" });
      const prover = getClaimProver();
      await prover.ready();
      await prover.prove(
        {
          circuitId: "claim",
          input: { entry, leafIndex: order.claim.leafIndex } as unknown as Record<
            string,
            unknown
          >,
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
      toast.push({
        kind: "success",
        title: `${order.label} claimed`,
        description: "Proceeds released to your recipient address.",
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      console.error("[claim]", e);
      const msg = e instanceof Error ? e.message : "Claim failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Claim failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [order, markClaimed, toast]);

  if (!order) return null;

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <Modal open={open} onClose={close} title="Claim proceeds">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
        <Row k="Order" v={order.label} />
        <Row k="Pair" v={order.pair} />
        <Row k="Side" v={order.side === "sell" ? "Sell" : "Buy"} />
        <Row k="Price" v={order.price} />
        <Row k="Size" v={order.size} />
        {order.claim && (
          <Row k="Receive" v={`${order.claim.amount.toString()} (raw units)`} />
        )}
      </dl>

      <PhaseStatus phase={phase} />

      <div className="mt-5 flex justify-end gap-2">
        {phase.kind === "success" ? (
          <Button onClick={close} size="lg">
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              {busy ? "Cancel" : "Close"}
            </Button>
            <Button
              onClick={submit}
              disabled={busy || !order.claim}
              title={!order.claim ? "No claim material on this order" : undefined}
            >
              {busy ? "Working…" : "Claim"}
            </Button>
          </>
        )}
      </div>
    </Modal>
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
