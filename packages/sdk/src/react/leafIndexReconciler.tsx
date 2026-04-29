"use client";

import { useEffect } from "react";

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

/** Subset of `CommitmentTreeState` the reconciler reads. Apps can
 *  pass either the SDK provider's value directly or any wrapper
 *  whose shape matches. */
export interface LeafIndexTree {
  ready: boolean;
  mode: "demo" | "live";
  /** Bumped each time the tree absorbs a new event — the only thing
   *  the reconciler effect needs to retrigger on. */
  leafCount: number;
  findIndex(commitment: bigint): number;
}

export interface UseLeafIndexReconcilerArgs {
  notes: readonly LeafIndexNote[];
  setLeafIndex(id: string, leafIndex: number): Promise<void>;
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
}
