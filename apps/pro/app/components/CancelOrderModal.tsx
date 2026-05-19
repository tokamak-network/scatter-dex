"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { idForCommitment } from "@zkscatter/sdk/notes";
import {
  assembleCancelProofResult,
  type CancelProofInput,
} from "@zkscatter/sdk/zk";
import { Button, Modal, useToast } from "@zkscatter/ui";
import { useOrders, type OrderRecord } from "../lib/orders";
import { useVault } from "../lib/vault";
import { useEdDSAKey } from "@zkscatter/sdk/react";
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

/** Returns the first reason the cancel flow cannot proceed, or null
 *  when everything is wired up. Same checks were duplicated between
 *  the in-modal disable guard and submit()'s runtime error path. */
function cancelBlockReason(
  order: OrderRecord,
  notes: ReadonlyArray<{ id: string }>,
  selectedRelayer: { address: string } | null,
): string | null {
  if (order.nonce === undefined || order.noteId === undefined) {
    return "Order is missing the nonce / funding-note metadata required to cancel.";
  }
  if (!notes.some((n) => n.id === order.noteId)) {
    return "The note that funded this order is no longer in your vault — cancel cannot proceed.";
  }
  if (!selectedRelayer) {
    return "Pick an online relayer (top-right pill) before cancelling — the cancel proof binds the submitter.";
  }
  return null;
}

export function CancelOrderModal({ open, onClose, order }: Props) {
  const { markCancelled } = useOrders();
  const { notes, add: vaultAdd, remove: vaultRemove } = useVault();
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
    const reason = cancelBlockReason(order, notes, selectedRelayer);
    if (reason) {
      setPhase({ kind: "error", message: reason });
      return;
    }
    // Non-null assertions justified by cancelBlockReason — all three
    // checks above guarantee these when reason is null.
    const note = notes.find((n) => n.id === order.noteId)!;
    const relayerAddr = selectedRelayer!.address;

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
        nonce: order.nonce!,
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

      // Vault rotation: cancel emits a fresh commitment for the
      // same balance (new salt). Persist the rotated note so the
      // user can immediately re-order with it, and drop the old
      // note since its nullifier is now on-chain. `leafIndex: -1`
      // is filled in by `useLeafIndexReconciler` once the chain's
      // `CommitmentInserted` event for the fresh commitment lands.
      //
      // Gated on `freshSalt !== 0n` because the worker may omit
      // the meta channel in some paths (see assembleCancelProofResult),
      // in which case rotation is unsafe and we leave the old note
      // alone — better a zombie than a lost balance.
      if (cancelProof.freshSalt !== 0n) {
        // Split the add/remove try/catches so a partial failure
        // (add succeeded but remove threw) is logged with both
        // ids — the user is otherwise left with a "double balance"
        // panel (rotated + original) and no way to tell which note
        // is the live one. folderAdapter.remove now swallows
        // removeFile errors internally so this path is unlikely,
        // but keeping the asymmetric logging means we'd see it
        // immediately if the contract ever changes.
        let addedRotated = false;
        try {
          await vaultAdd({
            symbol: note.symbol,
            amount: note.amount,
            note: { ...note.note, salt: cancelProof.freshSalt },
            commitment: cancelProof.newCommitment,
          });
          addedRotated = true;
        } catch (addErr) {
          console.warn("[cancel] vault rotation: add(new) failed — rotated note not persisted, on-chain cancel is final", addErr);
        }
        try {
          await vaultRemove(note.id);
        } catch (removeErr) {
          console.error(
            `[cancel] vault rotation: remove(old=${note.id}) failed — vault now shows both the rotated and the (on-chain-nullified) original. Manually remove note ${note.id} to fix.`,
            { addedRotated, removeErr },
          );
        }
      }

      // Change-note orphan cleanup: when the order was submitted
      // with a partial fill we pre-saved a change note to the
      // vault. Cancellation kills the order before settle, so the
      // change commitment never lands on chain and the note stays
      // in `pending` forever. Remove it by id (content-addressed
      // via `idForCommitment`) so the panel doesn't accumulate
      // stranded entries. Fire-and-forget — a failure here just
      // leaves the orphan visible; vault.remove already swallows
      // folder-adapter cleanup errors so this is unlikely to throw.
      if (order.changeCommitment !== undefined) {
        const changeId = idForCommitment(order.changeCommitment);
        vaultRemove(changeId).catch((err) => {
          console.warn(`[cancel] change-note orphan cleanup (id=${changeId}) failed`, err);
        });
      }

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

  // Disable the button + show the same reason inline BEFORE the user
  // clicks and burns the 1–2 s prove.
  const blockReason = cancelBlockReason(order, notes, selectedRelayer);

  return (
    <Modal open={open} onClose={close} title="Cancel order" closeOnBackdrop={false}>
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

      {blockReason && phase.kind !== "success" && (
        <div className="mt-4 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          ⚠ {blockReason}
        </div>
      )}

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
              disabled={busy || isDeriving || blockReason !== null}
              title={
                blockReason ??
                (isDeriving ? "Awaiting wallet signature…" : undefined)
              }
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
