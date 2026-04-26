"use client";

import {
  createWebWorkerProver,
  timeProve,
  type Prover,
  type ProveOpts,
  type ProveRequest,
  type ProveResult,
} from "@zkscatter/sdk/zk";

/** Single shared prover instance for the cancel (escrow rotation)
 *  flow. Spawned lazily so users who never cancel an order don't pay
 *  the ~11 MB asset fetch.
 *
 *  The returned prover wraps `prove()` with `timeProve` on the main
 *  thread — workers can't dispatch the `zk-perf:prove` window event,
 *  so timing the round-trip from the host is the simplest path that
 *  preserves telemetry. The extra postMessage overhead vs measuring
 *  inside the worker is negligible (a few ms on a 1–9 s proof). */
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

function wrapWithTimer(circuit: "authorize" | "cancel", inner: Prover): Prover {
  return {
    ready: () => inner.ready(),
    prove: (req: ProveRequest, opts?: ProveOpts): Promise<ProveResult> =>
      timeProve(circuit, () => inner.prove(req, opts)),
    dispose: () => inner.dispose(),
  };
}
