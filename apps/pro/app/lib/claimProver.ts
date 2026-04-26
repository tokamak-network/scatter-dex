"use client";

import { createWebWorkerProver, type Prover } from "@zkscatter/sdk/zk";
import { wrapWithTimer } from "./proverTimer";

/** Single shared prover instance for the claim flow.
 *
 *  Real Web Worker pointed at `app/workers/claim.worker.ts`, which
 *  calls `generateClaimProof` against the bundled claim circuit
 *  assets in `public/zk/`. */
let _prover: Prover | null = null;

export function getClaimProver(): Prover {
  if (!_prover) {
    const inner = createWebWorkerProver({
      label: "claim",
      createWorker: () =>
        new Worker(
          new URL("../workers/claim.worker.ts", import.meta.url),
          { type: "module" },
        ),
    });
    _prover = wrapWithTimer("claim", inner);
  }
  return _prover;
}
