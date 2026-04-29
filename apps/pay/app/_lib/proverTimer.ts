"use client";

import {
  timeProve,
  type Prover,
  type ProveOpts,
  type ProveRequest,
  type ProveResult,
  type ZkCircuit,
} from "@zkscatter/sdk/zk";

export function wrapWithTimer(circuit: ZkCircuit, inner: Prover): Prover {
  return {
    ready: () => inner.ready(),
    prove: (req: ProveRequest, opts?: ProveOpts): Promise<ProveResult> =>
      timeProve(circuit, () => inner.prove(req, opts)),
    dispose: () => inner.dispose(),
  };
}
