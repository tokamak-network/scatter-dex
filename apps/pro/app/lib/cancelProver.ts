"use client";

import { createWebWorkerProver, type Prover } from "@zkscatter/sdk/zk";

/** Single shared prover instance for the cancel (escrow rotation)
 *  flow. Spawned lazily so users who never cancel an order don't pay
 *  the ~11 MB asset fetch.
 *
 *  Worker spawn failure surfaces to the caller — we deliberately
 *  don't fall back to main-thread proving (would freeze the UI for
 *  several seconds). */
let _prover: Prover | null = null;

export function getCancelProver(): Prover {
  if (!_prover) {
    _prover = createWebWorkerProver({
      label: "cancel",
      createWorker: () =>
        new Worker(
          new URL("../workers/cancel.worker.ts", import.meta.url),
          { type: "module" },
        ),
    });
  }
  return _prover;
}
