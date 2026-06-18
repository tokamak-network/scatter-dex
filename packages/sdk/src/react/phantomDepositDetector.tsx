"use client";

import { useCallback, useRef } from "react";
import type { ethers } from "ethers";
import { useTimedRefresh } from "./useTimedRefresh";

/** Minimal note shape the phantom detector needs. App note types are
 *  wider; structural typing keeps the hook decoupled from any one
 *  vault implementation. */
export interface PhantomDepositNote {
  id: string;
  /** -1 = deposit not yet reconciled to a leaf. ≥0 = on-chain, skipped. */
  leafIndex: number;
  /** Deposit tx hash. Without it the receipt can't be checked, so the
   *  note is skipped (left Pending). */
  txHash?: string;
  /** ms epoch the note was added. */
  createdAt: number;
  /** Already-decided verdict; `"failed"` notes are skipped. */
  status?: "failed";
}

export interface UsePhantomDepositDetectorArgs {
  notes: readonly PhantomDepositNote[];
  /** Flags a note whose deposit tx is *proven reverted*. Must be
   *  referentially stable-ish; it's read through a ref so identity
   *  churn doesn't restart the poll. Idempotent on the vault side. */
  markFailed(id: string): Promise<void>;
  /** Provider used to read tx receipts — use the public / authoritative
   *  node, since a reverted receipt is a global fact independent of the
   *  wallet's view. `null`/`undefined` disables the detector. */
  provider: ethers.Provider | null | undefined;
  /** Only probe notes older than this (ms) so a just-broadcast deposit
   *  that's legitimately mining isn't judged prematurely. Default 60s. */
  staleAfterMs?: number;
  /** Poll cadence (ms). Default 30s — receipts are cheap but a reverted
   *  tx is terminal, so there's no need to hammer. */
  intervalMs?: number;
  label?: string;
}

/** Detects and flags **phantom deposits**: pending notes (leafIndex<0)
 *  whose deposit transaction *reverted*, so the commitment was never
 *  inserted and the note can never reconcile to a leaf. Such a note
 *  otherwise sits as "Pending" forever; flagging it `"failed"` lets the
 *  UI filter it out.
 *
 *  SAFETY — only a `receipt.status === 0` (reverted) verdict triggers a
 *  flag. A `null` receipt (still pending or dropped — could yet mine)
 *  and a `status === 1` receipt (succeeded, just not indexed yet) are
 *  deliberately left untouched: flagging either could strand a real,
 *  recoverable deposit (its spendable secret would be hidden). A
 *  reverted tx, by contrast, consumed its nonce and can never insert the
 *  commitment, and moved no funds — so the verdict is definitive. */
export function usePhantomDepositDetector({
  notes,
  markFailed,
  provider,
  staleAfterMs = 60_000,
  intervalMs = 30_000,
  label = "phantomDepositDetector",
}: UsePhantomDepositDetectorArgs): void {
  // Mirror live inputs into refs so the poll reads fresh values without
  // re-arming the timer on every render / note change.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const markRef = useRef(markFailed);
  markRef.current = markFailed;
  // Tx hashes whose receipt was found *non-reverted*: a mined tx can't
  // later revert, so we stop re-checking it every tick (saves the RPC a
  // call/note/tick forever once a stuck-but-mined deposit is seen).
  const clearedRef = useRef<Set<string>>(new Set());
  // Skip a tick while the previous scan is still in flight (slow RPC) so
  // overlapping polls don't double-check the same notes.
  const runningRef = useRef(false);

  const scan = useCallback(async () => {
    const prov = providerRef.current;
    if (!prov || runningRef.current) return;
    const now = Date.now();
    const targets = notesRef.current.filter(
      (n) =>
        n.leafIndex < 0 &&
        n.status !== "failed" &&
        !!n.txHash &&
        !clearedRef.current.has(n.txHash) &&
        now - n.createdAt > staleAfterMs,
    );
    if (targets.length === 0) return;
    runningRef.current = true;
    try {
      // Independent receipt reads → fan out in parallel.
      const results = await Promise.all(
        targets.map((n) =>
          prov
            .getTransactionReceipt(n.txHash!)
            .then((receipt) => ({ n, receipt }))
            .catch((e) => {
              console.warn(`[${label}] receipt check failed for ${n.txHash}:`, e);
              return { n, receipt: null as ethers.TransactionReceipt | null };
            }),
        ),
      );
      const failedIds: string[] = [];
      for (const { n, receipt } of results) {
        // null (pending/dropped — may yet mine) → re-check next tick.
        if (!receipt) continue;
        if (receipt.status === 0)
          failedIds.push(n.id); // reverted → phantom. See SAFETY note above.
        else clearedRef.current.add(n.txHash!); // mined OK → stop re-checking.
      }
      await Promise.all(
        failedIds.map((id) =>
          markRef.current(id).catch((e) =>
            console.warn(`[${label}] markFailed failed:`, e),
          ),
        ),
      );
    } finally {
      runningRef.current = false;
    }
  }, [staleAfterMs, label]);

  // Polls on a timer + on tab-visible, skipping hidden tabs — same
  // scheduler the leaf reconciler / relayer list use.
  useTimedRefresh({ refresh: scan, intervalMs, enabled: !!provider });
}
