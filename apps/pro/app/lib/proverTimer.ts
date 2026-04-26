"use client";

import {
  timeProve,
  type Prover,
  type ProveOpts,
  type ProveRequest,
  type ProveResult,
  type ZkCircuit,
} from "@zkscatter/sdk/zk";

/** Wrap a `Prover` so each `prove()` call is bracketed by
 *  `timeProve(circuit, ...)`. Telemetry runs on the main thread —
 *  workers can't dispatch the `zk-perf:prove` window event, and the
 *  postMessage round-trip is in the noise on a 1–9 s proof. */
export function wrapWithTimer(circuit: ZkCircuit, inner: Prover): Prover {
  return {
    ready: () => inner.ready(),
    prove: (req: ProveRequest, opts?: ProveOpts): Promise<ProveResult> =>
      timeProve(circuit, () => inner.prove(req, opts)),
    dispose: () => inner.dispose(),
  };
}
