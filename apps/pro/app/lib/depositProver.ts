"use client";

import { createWebWorkerProver, type Prover } from "@zkscatter/sdk/zk";
import { wrapWithTimer } from "./proverTimer";

/** Single shared prover instance for the deposit flow.
 *
 *  Real Web Worker pointed at `app/workers/deposit.worker.ts`, which
 *  calls `generateDepositProof` against the bundled deposit circuit
 *  assets in `public/zk/`. The worker is spawned lazily (first
 *  `prove` / `ready` call) so users who never deposit don't pay the
 *  asset fetch.
 *
 *  No fallback is configured — Worker spawn failure surfaces to the
 *  caller. Snarkjs on the main thread would freeze the UI for the
 *  full proof duration. */
let _prover: Prover | null = null;

export function getDepositProver(): Prover {
  if (!_prover) {
    const inner = createWebWorkerProver({
      label: "deposit",
      createWorker: () =>
        new Worker(
          new URL("../workers/deposit.worker.ts", import.meta.url),
          { type: "module" },
        ),
    });
    _prover = wrapWithTimer("deposit", inner);
  }
  return _prover;
}
