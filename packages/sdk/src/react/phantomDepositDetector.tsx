"use client";

import { useEffect, useRef } from "react";
import type { ethers } from "ethers";

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
  // restarting its interval on every render / note change.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const markRef = useRef(markFailed);
  markRef.current = markFailed;
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const scan = async () => {
      const prov = providerRef.current;
      if (!prov) return;
      const now = Date.now();
      const targets = notesRef.current.filter(
        (n) =>
          n.leafIndex < 0 &&
          n.status !== "failed" &&
          !!n.txHash &&
          now - n.createdAt > staleAfterMs &&
          !inFlightRef.current.has(n.id),
      );
      for (const n of targets) {
        inFlightRef.current.add(n.id);
        try {
          const receipt = await prov.getTransactionReceipt(n.txHash!);
          if (cancelled) return;
          if (receipt && receipt.status === 0) {
            await markRef.current(n.id).catch((e) =>
              console.warn(`[${label}] markFailed failed:`, e),
            );
          }
          // receipt == null (pending/dropped) or status === 1 (mined OK,
          // awaiting indexing) → leave untouched. See SAFETY note above.
        } catch (e) {
          console.warn(`[${label}] receipt check failed for ${n.txHash}:`, e);
        } finally {
          inFlightRef.current.delete(n.id);
        }
      }
    };
    void scan();
    const id = setInterval(() => void scan(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, staleAfterMs, label]);
}
