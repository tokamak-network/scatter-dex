"use client";

import { useCallback, useState } from "react";

// Structural mirror of ethers v6's TransactionResponse — only the
// fields we touch — so this hook stays consumable from apps that
// don't list `ethers` as a direct dependency.
interface TransactionLike {
  hash: string;
  wait(): Promise<{ hash?: string } | null>;
}

export type WritePhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string }
  | { kind: "error"; msg: string };

export interface UseChainWrite {
  phase: WritePhase;
  /** Submit a write. Wraps the standard
   *  `submitting → wait → success | error` lifecycle and routes
   *  errors through the configured `explain` so panel copy stays
   *  consistent across pages. */
  run: (thunk: () => Promise<TransactionLike>) => Promise<void>;
  reset: () => void;
}

interface UseChainWriteOpts {
  /** Map raw errors (revert custom errors, validation throws) to
   *  user-facing copy. Each contract surface owns its own
   *  explainer in the SDK so this hook can stay contract-agnostic. */
  explain: (err: unknown) => string;
  /** Fires after a transaction confirms. Typical use: invalidate
   *  the on-chain row provider so the panel reflects the new
   *  state. */
  onSuccess?: () => void;
}

/** Shared lifecycle hook for any single-shot contract write
 *  surfaced from the operators app — registry edits, fee-vault
 *  claims, future treasury actions. Each consumer owns its own
 *  phase, so multiple panels on the same page don't collide. */
export function useChainWrite(opts: UseChainWriteOpts): UseChainWrite {
  const [phase, setPhase] = useState<WritePhase>({ kind: "idle" });
  const { explain, onSuccess } = opts;

  const run = useCallback(async (thunk: () => Promise<TransactionLike>) => {
    setPhase({ kind: "submitting" });
    try {
      const tx = await thunk();
      const receipt = await tx.wait();
      setPhase({ kind: "success", txHash: receipt?.hash ?? tx.hash });
      onSuccess?.();
    } catch (err) {
      setPhase({ kind: "error", msg: explain(err) });
    }
  }, [explain, onSuccess]);

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  return { phase, run, reset };
}
