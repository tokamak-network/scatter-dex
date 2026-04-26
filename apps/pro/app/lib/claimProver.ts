"use client";

import { createMockProver, type Prover } from "@zkscatter/sdk/zk";

/** Single shared prover instance for the claim flow.
 *
 *  Phase 4b uses `createMockProver` because the claim circuit's
 *  wasm/zkey aren't yet in `circuits/build/` (only authorize is
 *  built). When the claim assets ship, swap this for
 *  `createWebWorkerProver` pointed at a worker file that calls
 *  `generateClaimProof`. The interface is identical, so
 *  `ClaimModal` doesn't change. */
let _prover: Prover | null = null;

export function getClaimProver(): Prover {
  if (!_prover) {
    _prover = createMockProver({ latencyMs: 2000, publicSignalsCount: 6 });
  }
  return _prover;
}
