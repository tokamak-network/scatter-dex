"use client";

import { createWebWorkerProver, type Prover } from "@zkscatter/sdk/zk";
import { wrapWithTimer } from "./proverTimer";

/** Lazy-spawned authorize prover for Pay's payout flow. Mirrors Pro's
 *  authorizeProver — the worker pulls the same circuit assets from
 *  `public/zk/` so a payout's proof runs off the main thread.
 *
 *  No fallback is configured; spawn failure surfaces to the caller. */
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
