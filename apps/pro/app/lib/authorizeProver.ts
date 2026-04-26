"use client";

import { createWebWorkerProver, type Prover } from "@zkscatter/sdk/zk";
import { wrapWithTimer } from "./proverTimer";

/** Single shared prover instance for the authorize (limit-order)
 *  flow.
 *
 *  Real Web Worker pointed at `app/workers/authorize.worker.ts`,
 *  which calls `generateAuthorizeProof` against the bundled
 *  authorize circuit assets in `public/zk/`. The worker is spawned
 *  lazily (first `prove` / `ready` call) so users who never place
 *  an order don't pay the ~24 MB asset fetch.
 *
 *  No fallback is configured — Worker spawn failure surfaces to the
 *  caller. We deliberately don't run snarkjs on the main thread (it
 *  would freeze the UI for several seconds). */
let _prover: Prover | null = null;

export function getAuthorizeProver(): Prover {
  if (!_prover) {
    const inner = createWebWorkerProver({
      label: "authorize",
      createWorker: () =>
        new Worker(
          new URL("../workers/authorize.worker.ts", import.meta.url),
          { type: "module" },
        ),
    });
    _prover = wrapWithTimer("authorize", inner);
  }
  return _prover;
}
