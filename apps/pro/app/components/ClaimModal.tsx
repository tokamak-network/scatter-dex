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
import { useCuratedNetworkTokens } from "@zkscatter/sdk/react";

type Phase =
  | { kind: "idle" }
  | {
      kind: "claiming";
      leafIndex: number;
      message: string;
    }
  | { kind: "success"; leafIndex: number }
  | { kind: "error"; leafIndex: number; message: string };

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
  const { tokens: liveTokens } = useCuratedNetworkTokens(network);
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Mirror the persisted `claimedLeafIndexes` into local state so the
  // checkbox reflects each successful leaf immediately without waiting
  // for the store to round-trip. Re-seeded on order swap.
  const [doneLocally, setDoneLocally] = useState<Set<number>>(new Set());
  const abortCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: "idle" });
    setDoneLocally(new Set(order?.claimedLeafIndexes ?? []));
  }, [open, order]);

  const allClaims = useMemo(() => (order ? claimList(order) : []), [order]);

  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

  /** Claim a single recipient's leaf — prove + (stub-)submit, then
   *  persist via markLeafClaimed. Only one claim runs at a time;
   *  re-entrant clicks while a claim is in flight are gated by the
   *  per-row disabled state below. */
  const claimOne = useCallback(
    async (c: OrderClaim) => {
      if (!order) return;
      // Abort any in-flight prior claim before starting a new one —
      // covers the edge where two row buttons get tapped in quick
      // succession before React disables the second.
      abortCtrlRef.current?.abort();
      const ctrl = new AbortController();
      abortCtrlRef.current = ctrl;

      setPhase({
        kind: "claiming",
        leafIndex: c.leafIndex,
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
        await claimProver.ready();
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
            onProgress: (m) => {
              if (ctrl.signal.aborted) return;
              setPhase({ kind: "claiming", leafIndex: c.leafIndex, message: m });
            },
          },
        );
        // TODO: on-chain per-leaf `claim` dispatch. The brief sleep
        // keeps the demo's progress indicator perceptible until real
        // tx submission lands.
        await abortableSleep(200, ctrl.signal);
        markLeafClaimed(order.id, c.leafIndex);
        setDoneLocally((prev) => {
          const next = new Set(prev);
          next.add(c.leafIndex);
          return next;
        });
        setPhase({ kind: "success", leafIndex: c.leafIndex });
        toast.push({
          kind: "success",
          title: `${order.label} · recipient #${c.leafIndex + 1} claimed`,
          description: "Proceeds released to the recipient address.",
        });
      } catch (e) {
        if (isAbortError(e, ctrl.signal)) return;
        console.error("[claim]", e);
        const msg = e instanceof Error ? e.message : "Claim failed.";
        setPhase({ kind: "error", leafIndex: c.leafIndex, message: msg });
        toast.push({ kind: "error", title: "Claim failed", description: msg });
      } finally {
        if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
      }
    },
    [order, markLeafClaimed, toast],
  );

  if (!order) return null;

  if (open && identityBlocking) {
    return <IdentityGateModal state={identityState} onClose={close} />;
  }

  const noClaimMaterial = allClaims.length === 0;
  // `allDone` derived against the intersection of allClaims and
  // doneLocally so a stale leafIndex in claimedLeafIndexes (longer
  // than current claims, e.g. after a future schema change) can't
  // falsely flip to "all done" before every CURRENT leaf is claimed.
  const allDone =
    !noClaimMaterial && allClaims.every((c) => doneLocally.has(c.leafIndex));
  const doneCount = allClaims.reduce(
    (n, c) => (doneLocally.has(c.leafIndex) ? n + 1 : n),
    0,
  );
  const busyLeaf = phase.kind === "claiming" ? phase.leafIndex : null;

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
              : allClaims.length === 1
                ? doneCount === 1 ? "1 / 1 claimed" : "1 to claim"
                : `${doneCount} / ${allClaims.length} claimed`
          }
        />
      </dl>

      {!noClaimMaterial && (
        <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="border-b border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-muted)]">
            Per-recipient claim
          </div>
          <ul className="max-h-72 overflow-y-auto divide-y divide-[var(--color-border)]">
            {allClaims.map((c) => {
              const done = doneLocally.has(c.leafIndex);
              const claiming = busyLeaf === c.leafIndex;
              const errored =
                phase.kind === "error" && phase.leafIndex === c.leafIndex;
              return (
                <li
                  key={c.leafIndex}
                  className={`flex items-center gap-3 px-3 py-2 text-xs ${
                    claiming ? "bg-[var(--color-primary-soft)]" : ""
                  }`}
                >
                  <span className="w-8 text-[var(--color-text-subtle)]">
                    #{c.leafIndex + 1}
                  </span>
                  <span className="flex-1 truncate font-mono text-[11px]">
                    {c.recipient.slice(0, 6)}…{c.recipient.slice(-4)}
                  </span>
                  <span className="font-medium">
                    {formatClaimAmount(c.amount, c.token, liveTokens)}
                  </span>
                  <span className="w-24 text-right">
                    {done ? (
                      <span className="text-[10px] text-[var(--color-success)]">
                        ✓ claimed
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void claimOne(c)}
                        disabled={busyLeaf !== null}
                        className="rounded border border-[var(--color-primary)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {claiming ? "Claiming…" : errored ? "Retry" : "Claim"}
                      </button>
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
        {allDone ? (
          <Button onClick={close} size="lg">
            Done
          </Button>
        ) : (
          <Button variant="secondary" onClick={close}>
            {phase.kind === "claiming" ? "Cancel" : "Close"}
          </Button>
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
  if (phase.kind === "success") return null; // per-row badge carries the signal

  if (phase.kind === "error") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-danger)]">
        Recipient #{phase.leafIndex + 1}: {phase.message}
      </div>
    );
  }

  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span className="flex-1">{phase.message}</span>
    </div>
  );
}
