"use client";

import {
  createMockProver,
  type Prover,
} from "@zkscatter/sdk/zk";

/** Single shared prover instance for the deposit flow.
 *
 *  Phase 2b-ii uses `createMockProver` because the deposit circuit's
 *  wasm/zkey haven't been built into this repo yet (see
 *  `circuits/build/` — only `authorize_*` is present). When the
 *  deposit assets ship, swap this for `createWebWorkerProver`
 *  pointed at a worker file that calls `generateDepositProof` with
 *  real assets. The interface stays identical, so consumers
 *  (`DepositModal`) don't change.
 *
 *  Mock latency tuned to ~1.5 s — enough to make spinner / progress
 *  states visible during demos without dragging tests. */
let _prover: Prover | null = null;

export function getDepositProver(): Prover {
  if (!_prover) {
    _prover = createMockProver({ latencyMs: 1500, publicSignalsCount: 1 });
  }
  return _prover;
}
