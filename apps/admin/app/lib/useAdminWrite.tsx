"use client";

import { useCallback, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { explainError } from "./format";

interface TransactionLike {
  hash: string;
  wait(): Promise<{ hash?: string } | null>;
}

export type WritePhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string }
  | { kind: "error"; msg: string };

export interface UseAdminWrite {
  phase: WritePhase;
  account: string | null;
  connect: () => Promise<void>;
  /** Submit a write thunk; tracks lifecycle through `phase`. */
  run: (thunk: () => Promise<TransactionLike>) => Promise<void>;
  reset: () => void;
}

/** Lightweight write hook shared by every admin write action. Tracks
 *  submit→wait→success/error and exposes the connect-wallet flow so
 *  individual panels don't each re-implement it. */
export function useAdminWrite(onSuccess?: () => void): UseAdminWrite {
  const { account, connect } = useWallet();
  const [phase, setPhase] = useState<WritePhase>({ kind: "idle" });

  const run = useCallback(
    async (thunk: () => Promise<TransactionLike>) => {
      setPhase({ kind: "submitting" });
      try {
        const tx = await thunk();
        const receipt = await tx.wait();
        setPhase({ kind: "success", txHash: receipt?.hash ?? tx.hash });
        onSuccess?.();
      } catch (err) {
        setPhase({ kind: "error", msg: explainError(err) });
      }
    },
    [onSuccess],
  );

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  return { phase, account, connect, run, reset };
}

/** Inline status banner for admin write actions. Reused so all
 *  panels render confirms/errors with the same copy. */
export function WriteStatus({ phase }: { phase: WritePhase }) {
  if (phase.kind === "success") {
    return (
      <div className="mt-2 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-1.5 text-xs text-[var(--color-success)]">
        Confirmed · <code className="font-mono">{phase.txHash.slice(0, 10)}…</code>
      </div>
    );
  }
  if (phase.kind === "error") {
    return (
      <div className="mt-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-1.5 text-xs text-[var(--color-danger)]">
        {phase.msg}
      </div>
    );
  }
  return null;
}
