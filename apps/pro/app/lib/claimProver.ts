"use client";

import { createMockProver, type Prover } from "@zkscatter/sdk/zk";

/** Lazy singleton claim prover. Mock until the claim circuit
 *  wasm/zkey ship; swap for `createWebWorkerProver` then. The
 *  `ClaimModal` consumer doesn't change. */
let prover: Prover | null = null;

export function getClaimProver(): Prover {
  if (!prover) {
    prover = createMockProver({ latencyMs: 2000, publicSignalsCount: 6 });
  }
  return prover;
}
