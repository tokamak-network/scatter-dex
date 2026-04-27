"use client";

import { useCallback, useState } from "react";
import { explainRegistryError } from "@zkscatter/sdk/relayer";

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

export interface UseRegistryWrite {
  phase: WritePhase;
  /** Submit a registry write. Wraps the standard
   *  `submitting → wait → success | error` lifecycle and routes
   *  errors through `explainRegistryError` so panels share copy. */
  run: (thunk: () => Promise<TransactionLike>) => Promise<void>;
  reset: () => void;
}

interface UseRegistryWriteOpts {
  /** Fires after a transaction confirms. Typical use: invalidate
   *  `useOperator()` so the panel reflects the new on-chain row. */
  onSuccess?: () => void;
  /** `InsufficientBond` error copy interpolates this. Pass the
   *  current `row.bond` when known; defaults to `0n`. */
  minBond?: bigint;
}

/** Shared lifecycle hook for every registry write surfaced from
 *  the operators app — register, updateInfo, addBond, requestExit,
 *  executeExit. Each consumer owns its own phase, so multiple
 *  panels on the same page don't collide. */
export function useRegistryWrite(opts: UseRegistryWriteOpts = {}): UseRegistryWrite {
  const [phase, setPhase] = useState<WritePhase>({ kind: "idle" });
  const { onSuccess, minBond = 0n } = opts;

  const run = useCallback(async (thunk: () => Promise<TransactionLike>) => {
    setPhase({ kind: "submitting" });
    try {
      const tx = await thunk();
      const receipt = await tx.wait();
      setPhase({ kind: "success", txHash: receipt?.hash ?? tx.hash });
      onSuccess?.();
    } catch (err) {
      setPhase({ kind: "error", msg: explainRegistryError(err, minBond) });
    }
  }, [onSuccess, minBond]);

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  return { phase, run, reset };
}
