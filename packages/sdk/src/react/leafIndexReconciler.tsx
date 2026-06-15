"use client";

import { useEffect, useRef, useState } from "react";
import type { CommitmentTreeState } from "./commitmentTree";
import { useTimedRefresh } from "./useTimedRefresh";

/** Minimal note shape the reconciler needs: a stable id, the
 *  on-chain index it's waiting for, and the commitment to look up
 *  in the tree. App-specific note types are wider; structural
 *  typing lets `useLeafIndexReconciler` work without coupling to
 *  any one vault implementation. */
export interface LeafIndexNote {
  id: string;
  /** -1 means "deposit confirmed but the CommitmentInserted event
   *  hasn't been reconciled yet". Anything ≥ 0 is treated as
   *  resolved and skipped. */
  leafIndex: number;
  commitment: bigint;
}

/** Subset of `CommitmentTreeState` the reconciler reads. Picked
 *  rather than redefined so a future field addition on the
 *  provider doesn't drift this contract. */
export type LeafIndexTree = Pick<
  CommitmentTreeState,
  "ready" | "mode" | "leafCount" | "findIndex" | "refresh"
>;

export interface UseLeafIndexReconcilerArgs {
  notes: readonly LeafIndexNote[];
  /** Atomic id → leafIndex updater. **Must be referentially stable**
   *  (wrap in `useCallback` with a stable dep set) — the hook lists
   *  it in the effect deps, so a fresh identity every render would
   *  retrigger the reconciliation pass even when nothing changed. */
  setLeafIndex(id: string, leafIndex: number): Promise<void>;
  /** Live tree state. `findIndex` must also be referentially stable;
   *  the SDK's `CommitmentTreeProvider` already returns a
   *  `useCallback`'d value, so passing the provider's value through
   *  unchanged is the easiest way to satisfy this. */
  tree: LeafIndexTree;
  /** Optional logger label used in the dropped-write warning so
   *  multi-app debug logs can tell who rejected. Defaults to
   *  "leafIndexReconciler". */
  label?: string;
}

/** Back-fills `leafIndex` on vault notes once the matching
 *  `CommitmentInserted` event lands in the live tree. Pure
 *  side-effect hook — no UI; pair with whatever the app uses to
 *  surface vault state.
 *
 *  Without this, every spend path that gates on `leafIndex >= 0`
 *  (Pay's realSettle, Pro's settle / cancel) leaves a freshly-
 *  deposited or change-UTXO note unspendable until the user
 *  manually refreshes. */
export function useLeafIndexReconciler({
  notes,
  setLeafIndex,
  tree,
  label = "leafIndexReconciler",
}: UseLeafIndexReconcilerArgs): void {
  useEffect(() => {
    if (!tree.ready || tree.mode === "demo") return;
    for (const n of notes) {
      if (n.leafIndex >= 0) continue;
      const idx = tree.findIndex(n.commitment);
      if (idx >= 0) {
        // Folder-backed adapters (File System Access API) can throw
        // if the user revokes permission mid-session. Swallow + log
        // so the recurring tick doesn't surface as an unhandled
        // rejection — the next leafCount change retries automatically.
        setLeafIndex(n.id, idx).catch((err) =>
          console.warn(`[${label}] setLeafIndex failed:`, err),
        );
      }
    }
  }, [notes, tree.ready, tree.mode, tree.leafCount, tree.findIndex, setLeafIndex, label]);

  // The reconcile pass above only fires when `tree.leafCount` changes —
  // it's reactive, not a poller. The tree's live subscription
  // (`subscribeCommitmentInserted`) is best-effort ethers polling and
  // CAN miss an insert, in which case `leafCount` never moves and a
  // freshly-deposited note stays at `leafIndex < 0` (unspendable) until
  // the user hard-refreshes. Self-heal: while any note is still pending,
  // re-hydrate the tree on a timer so a missed event is recovered
  // automatically; `tree.refresh()`'s own backoff coalesces bursts, and
  // `useTimedRefresh` also re-fires when the tab regains focus (the
  // "deposited in another tab" case).
  //
  // BOUNDED: a note that will NEVER reconcile (e.g. a discarded phantom
  // change note from an expired order — its `leafIndex` stays < 0 forever)
  // would otherwise keep this poll hitting the RPC indefinitely. So cap the
  // attempts and reset the budget whenever the pending SET changes (a note
  // reconciled, or a fresh deposit appeared) — genuine pendings always get
  // the full window, while a stuck phantom stops after it. If the event
  // does eventually land, the reactive pass above still reconciles it off
  // the subscription's own `leafCount` change.
  const pendingKey = notes
    .filter((n) => n.leafIndex < 0)
    .map((n) => n.id)
    .sort()
    .join("|");
  // Attempt counter lives in a ref so ticking it doesn't re-render every 3s.
  // Only the terminal "budget exhausted" transition flips state (once), which
  // is all `enabled` needs to stop the poll.
  const attemptsRef = useRef(0);
  const [pollExhausted, setPollExhausted] = useState(false);
  useEffect(() => {
    // Pending set changed (a note reconciled / a fresh deposit) → fresh budget.
    attemptsRef.current = 0;
    setPollExhausted(false);
  }, [pendingKey]);
  useTimedRefresh({
    refresh: () => {
      tree.refresh();
      attemptsRef.current += 1;
      if (attemptsRef.current >= SELF_HEAL_MAX_POLLS) setPollExhausted(true);
    },
    intervalMs: 3000,
    enabled:
      pendingKey.length > 0 &&
      !pollExhausted &&
      tree.ready &&
      tree.mode !== "demo",
  });
}

/** Cap on self-heal `tree.refresh` polls for an unchanged pending set —
 *  ~100 × 3s ≈ 5 min, ample for a real deposit to reconcile (a Sepolia
 *  block lands in ~12s) while bounding a phantom note's RPC churn. */
const SELF_HEAL_MAX_POLLS = 100;
