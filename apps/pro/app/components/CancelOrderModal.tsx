"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import {
  assembleCancelProofResult,
  type CancelProofInput,
} from "@zkscatter/sdk/zk";
import { Button, Modal, useToast } from "@zkscatter/ui";
import { useOrders, type OrderRecord } from "../lib/orders";
import { useVault } from "../lib/vault";
import { useEdDSAKey } from "../lib/eddsaKey";
import { useRelayers } from "../lib/relayers";
import { cancelProver } from "../lib/cancelProver";
import { buildEmptyTreeProof } from "../lib/emptyTreeProof";
import { useCommitmentTree, getMerkleProofWithFallback } from "../lib/commitmentTree";
import { computeCommitment } from "@zkscatter/sdk/zk";
import { dispatchCancel } from "../lib/dispatch";
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
  const commitmentTree = useCommitmentTree();
  const { selected: selectedRelayer } = useRelayers();
  const { signer } = useWallet();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  // Modal owns escape / focus restore / backdrop click; we still
  // need the abort + phase reset on close, so wrap onClose.
  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

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

      const commitment = await computeCommitment(note.note);
      const { merkleProof, leafIndex } = await getMerkleProofWithFallback(
        commitmentTree,
        commitment,
        () => buildEmptyTreeProof(note.note),
      );
      assertNotAborted(ctrl.signal);

      const input: CancelProofInput = {
        note: note.note,
        leafIndex,
        merkleProof,
        nonce: order.nonce,
        eddsaPrivateKey: eddsaKey.privateKey,
        relayer: relayerAddr,
      };

      setPhase({ kind: "proving", message: "Generating ZK cancel proof…" });
      await cancelProver.ready();
      const proveResult = await cancelProver.prove(
        { circuitId: "cancel", input: input as unknown as Record<string, unknown> },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );
      assertNotAborted(ctrl.signal);

      // SDK helper assembles the rich `CancelProofResult` from the
      // worker envelope. `freshSalt` arrives via the `meta` channel
      // (see `cancel.worker.ts`) and is needed for vault-rotation
      // persistence; `callCancel` itself doesn't read it.
      const cancelProof = assembleCancelProofResult(proveResult);

      setPhase({ kind: "submitting" });
      const dispatch = await dispatchCancel(signer, cancelProof);
      assertNotAborted(ctrl.signal);
      // Brief pause on the simulated path so the spinner is visible
      // — instant transitions read as "nothing happened".
      if (dispatch.kind === "simulated") {
        await abortableSleep(400, ctrl.signal);
      }

      markCancelled(order.id);
      setPhase({ kind: "success" });
      toast.push({
        kind: "success",
        title: `${order.label} cancelled`,
        description:
          dispatch.kind === "onchain"
            ? `On-chain cancellation submitted. Tx ${dispatch.txHash.slice(0, 10)}…`
            : "Cancel proof generated. On-chain rotation activates once the network has a deployed PrivateSettlement contract.",
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      const msg = e instanceof Error ? e.message : "Cancel failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Cancel failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [order, notes, selectedRelayer, signer, deriveEdDSA, markCancelled, toast, commitmentTree]);

  if (!order) return null;

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <Modal open={open} onClose={close} title="Cancel order">
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
        footer="Generates a ZK cancel proof binding the order's nonce nullifier to the chosen relayer. Once the contract dispatch ships, this also rotates the escrow to a fresh commitment so the same balance can immediately be re-ordered. Funds stay in your vault either way."
      />

      <PhaseStatus phase={phase} />

      <div className="mt-5 flex justify-end gap-2">
        {phase.kind === "success" ? (
          <Button onClick={close} size="lg">
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              {busy ? "Cancel" : "Keep order"}
            </Button>
            <Button
              variant="danger"
              onClick={submit}
              disabled={busy || isDeriving}
              title={isDeriving ? "Awaiting wallet signature…" : undefined}
            >
              {busy
                ? "Working…"
                : isDeriving
                ? "Awaiting signature…"
                : "Cancel order"}
            </Button>
          </>
        )}
      </div>
    </Modal>
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
