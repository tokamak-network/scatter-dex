"use client";

import { createWebWorkerProver, type Prover } from "@zkscatter/sdk/zk";
import { wrapWithTimer } from "./proverTimer";

/** Single shared prover instance for the cancel (escrow rotation)
 *  flow. Spawned lazily so users who never cancel an order don't pay
 *  the ~11 MB asset fetch. */
let _prover: Prover | null = null;

export function getCancelProver(): Prover {
  if (!_prover) {
    const inner = createWebWorkerProver({
      label: "cancel",
      createWorker: () =>
        new Worker(
          new URL("../workers/cancel.worker.ts", import.meta.url),
          { type: "module" },
        ),
    });
    _prover = wrapWithTimer("cancel", inner);
  }
  return _prover;
}
