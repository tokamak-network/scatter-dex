"use client";
import { useIdentityGate } from "../lib/identity";
import { IdentityGateModal } from "./IdentityGateModal";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, useToast } from "@zkscatter/ui";
import { TestnetNotice } from "./TestnetNotice";
import { useOrders, type OrderClaim, type OrderRecord } from "../lib/orders";
import { claimProver } from "../lib/claimProver";
import { abortableSleep, isAbortError } from "../lib/abort";
import { formatClaimAmount } from "../lib/format";
import { useActiveNetwork } from "../lib/activeNetwork";

type Phase =
  | { kind: "idle" }
  | {
      kind: "running";
      currentLeaf: number;
      currentPosition: number;
      total: number;
      message: string;
    }
  | { kind: "success"; claimedCount: number }
  | {
      kind: "partial";
      successCount: number;
      failed: Array<{ leafIndex: number; recipient: string; reason: string }>;
    }
  | { kind: "error"; message: string };

interface ClaimModalProps {
  open: boolean;
  onClose: () => void;
  order: OrderRecord | null;
}

/** Expand the order's claim material into a flat list. New writes
 *  always carry `claims` (the full per-recipient list); legacy rows
 *  may only have the singular `claim` — wrap it as a singleton so the
 *  downstream code paths can iterate uniformly. */
function claimList(order: OrderRecord): OrderClaim[] {
  if (order.claims && order.claims.length > 0) return order.claims;
  if (order.claim) return [order.claim];
  return [];
}

export function ClaimModal({ open, onClose, order }: ClaimModalProps) {
  const { state: identityState, blocking: identityBlocking } = useIdentityGate();
  const { markLeafClaimed } = useOrders();
  const { network } = useActiveNetwork();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Mirror the persisted `claimedLeafIndexes` into local state for
  // the in-progress UI — we want the checkbox to immediately reflect
  // each successful leaf without waiting for the store to round-trip
  // through React. Re-seeded on order swap so the next open starts
  // from the current truth.
  const [doneLocally, setDoneLocally] = useState<Set<number>>(new Set());
  // Initial selection: every leaf that hasn't already been claimed
  // (per the persisted set). Demo-friendly default — operator
  // typically clicks "Claim selected" once and walks away.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const abortCtrlRef = useRef<AbortController | null>(null);

  // Reset per-open so a re-open after a previous claim doesn't
  // surface stale `success` / `error` text or a stale selection.
  useEffect(() => {
    if (!open) return;
    setPhase({ kind: "idle" });
    setDoneLocally(new Set(order?.claimedLeafIndexes ?? []));
    if (order) {
      const persistedDone = new Set(order.claimedLeafIndexes ?? []);
      const next = new Set<number>();
      for (const c of claimList(order)) {
        if (!persistedDone.has(c.leafIndex)) next.add(c.leafIndex);
      }
      setSelected(next);
    } else {
      setSelected(new Set());
    }
  }, [open, order]);

  const allClaims = useMemo(() => (order ? claimList(order) : []), [order]);

  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

  const toggle = (leafIndex: number) => {
    if (doneLocally.has(leafIndex)) return; // already done — non-toggleable
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(leafIndex)) next.delete(leafIndex);
      else next.add(leafIndex);
      return next;
    });
  };
  const setAll = (value: boolean) => {
    setSelected(value
      ? new Set(allClaims.filter((c) => !doneLocally.has(c.leafIndex)).map((c) => c.leafIndex))
      : new Set());
  };

  /** Sequentially prove + (stub-)submit each selected leaf. Sequential
   *  not parallel because the underlying `claimProver` is a single
   *  shared web-worker — running two prove() calls concurrently would
   *  queue inside the worker anyway, and serial keeps the per-row
   *  progress legible ("3 / 5 claimed"). One failure doesn't abort
   *  the rest — the operator can re-run Claim selected with the
   *  remaining checkboxes on a re-attempt. */
  const submit = useCallback(async () => {
    if (!order) return;
    const targets = allClaims.filter((c) => selected.has(c.leafIndex));
    if (targets.length === 0) {
      setPhase({ kind: "error", message: "No recipients selected." });
      return;
    }

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;

    let successCount = 0;
    const failed: Array<{ leafIndex: number; recipient: string; reason: string }> = [];
    try {
      await claimProver.ready();
      for (let i = 0; i < targets.length; i++) {
        const c = targets[i];
        setPhase({
          kind: "running",
          currentLeaf: c.leafIndex,
          currentPosition: i + 1,
          total: targets.length,
          message: `Generating ZK claim proof for recipient #${c.leafIndex + 1}…`,
        });
        try {
          const entry = {
            secret: c.secret,
            recipient: BigInt(c.recipient),
            token: BigInt(c.token),
            amount: c.amount,
            releaseTime: c.releaseTime,
          };
          await claimProver.prove(
            {
              circuitId: "claim",
              input: { entry, leafIndex: c.leafIndex } as unknown as Record<
                string,
                unknown
              >,
            },
            {
              signal: ctrl.signal,
              onProgress: (m) =>
                setPhase({
                  kind: "running",
                  currentLeaf: c.leafIndex,
                  currentPosition: i + 1,
                  total: targets.length,
                  message: m,
                }),
            },
          );
          // TODO: on-chain per-leaf `claim` dispatch. The brief sleep
          // keeps the demo's progress bar perceptible until real tx
          // submission lands.
          await abortableSleep(200, ctrl.signal);
          markLeafClaimed(order.id, c.leafIndex);
          setDoneLocally((prev) => {
            const next = new Set(prev);
            next.add(c.leafIndex);
            return next;
          });
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(c.leafIndex);
            return next;
          });
          successCount += 1;
        } catch (e) {
          if (isAbortError(e, ctrl.signal)) throw e;
          console.error("[claim]", e);
          failed.push({
            leafIndex: c.leafIndex,
            recipient: c.recipient,
            reason: e instanceof Error ? e.message : "unknown",
          });
        }
      }

      if (failed.length === 0) {
        setPhase({ kind: "success", claimedCount: successCount });
        toast.push({
          kind: "success",
          title:
            successCount === 1
              ? `${order.label} claimed`
              : `${order.label}: ${successCount} recipients claimed`,
          description: "Proceeds released to each recipient address.",
        });
      } else {
        setPhase({ kind: "partial", successCount, failed });
        toast.push({
          kind: "error",
          title: `${order.label}: ${failed.length} of ${targets.length} failed`,
          description: "Re-select the failed rows and retry.",
        });
      }
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      const msg = e instanceof Error ? e.message : "Claim failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Claim failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [order, allClaims, selected, markLeafClaimed, toast]);

  if (!order) return null;

  // Identity gate — claims require a verified wallet (the on-chain
  // claim call is gated on the same IdentityGate). Surface the
  // gate prompt instead of the claim flow when the wallet is
  // unverified / expired / error.
  if (open && identityBlocking) {
    return <IdentityGateModal state={identityState} onClose={close} />;
  }

  const busy = phase.kind === "running";
  const noClaimMaterial = allClaims.length === 0;
  const allDone =
    !noClaimMaterial &&
    allClaims.every((c) => doneLocally.has(c.leafIndex));

  return (
    <Modal open={open} onClose={close} title="Claim proceeds" closeOnBackdrop={false}>
      <TestnetNotice />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
        <Row k="Order" v={order.label} />
        <Row k="Pair" v={order.pair} />
        <Row k="Side" v={order.side === "sell" ? "Sell" : "Buy"} />
        <Row k="Price" v={order.price} />
        <Row k="Size" v={order.size} />
        <Row
          k="Recipients"
          v={
            noClaimMaterial
              ? "—"
              : `${doneLocally.size} / ${allClaims.length} claimed`
          }
        />
      </dl>

      {!noClaimMaterial && (
        <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-xs">
            <span className="font-medium text-[var(--color-text-muted)]">
              Per-recipient claim
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setAll(true)}
                disabled={busy || allDone}
                className="text-[var(--color-primary)] hover:underline disabled:opacity-50 disabled:no-underline"
              >
                Select all open
              </button>
              <button
                type="button"
                onClick={() => setAll(false)}
                disabled={busy || selected.size === 0}
                className="text-[var(--color-text-muted)] hover:underline disabled:opacity-50 disabled:no-underline"
              >
                Clear
              </button>
            </div>
          </div>
          <ul className="max-h-60 overflow-y-auto divide-y divide-[var(--color-border)]">
            {allClaims.map((c) => {
              const done = doneLocally.has(c.leafIndex);
              const checked = !done && selected.has(c.leafIndex);
              const isCurrent =
                phase.kind === "running" && phase.currentLeaf === c.leafIndex;
              return (
                <li
                  key={c.leafIndex}
                  className={`flex items-center gap-3 px-3 py-2 text-xs ${
                    isCurrent ? "bg-[var(--color-primary-soft)]" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={done || checked}
                    disabled={done || busy}
                    onChange={() => toggle(c.leafIndex)}
                    aria-label={`Select recipient ${c.leafIndex + 1}`}
                  />
                  <span className="w-6 text-[var(--color-text-subtle)]">
                    #{c.leafIndex + 1}
                  </span>
                  <span className="flex-1 truncate font-mono text-[11px]">
                    {c.recipient.slice(0, 6)}…{c.recipient.slice(-4)}
                  </span>
                  <span className="font-medium">
                    {formatClaimAmount(c.amount, c.token, network.tokens)}
                  </span>
                  <span className="w-16 text-right text-[10px]">
                    {done ? (
                      <span className="text-[var(--color-success)]">✓ claimed</span>
                    ) : isCurrent ? (
                      <span className="text-[var(--color-primary)]">claiming…</span>
                    ) : (
                      <span className="text-[var(--color-text-subtle)]">open</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <PhaseStatus phase={phase} />

      <div className="mt-5 flex justify-end gap-2">
        {allDone || phase.kind === "success" ? (
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
              disabled={busy || noClaimMaterial || selected.size === 0}
              title={
                noClaimMaterial
                  ? "No claim material on this order"
                  : selected.size === 0
                    ? "Select at least one recipient"
                    : undefined
              }
            >
              {busy
                ? "Working…"
                : selected.size === 1
                  ? "Claim 1 recipient"
                  : `Claim ${selected.size} recipients`}
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
          {phase.claimedCount === 1
            ? "Recipient claimed"
            : `${phase.claimedCount} recipients claimed`}
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Proceeds released to each recipient address.
        </div>
      </div>
    );
  }

  if (phase.kind === "partial") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] px-3 py-2 text-sm">
        <div className="font-semibold text-[var(--color-danger)]">
          {phase.successCount} succeeded, {phase.failed.length} failed
        </div>
        <ul className="mt-1 list-disc pl-5 text-xs text-[var(--color-text-muted)]">
          {phase.failed.map((f) => (
            <li key={f.leafIndex}>
              #{f.leafIndex + 1}: {f.reason}
            </li>
          ))}
        </ul>
        <div className="mt-2 text-xs text-[var(--color-text-muted)]">
          Re-select the failed rows above and click Claim to retry.
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span className="flex-1">{phase.message}</span>
      <span className="text-xs text-[var(--color-text-muted)]">
        {phase.currentPosition} / {phase.total}
      </span>
    </div>
  );
}
