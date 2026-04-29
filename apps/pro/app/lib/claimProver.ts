"use client";

import { createLazyWorkerProver, type Prover } from "@zkscatter/sdk/zk";

const _prover = createLazyWorkerProver({
  circuit: "claim",
  createWorker: () =>
    new Worker(new URL("../workers/claim.worker.ts", import.meta.url), {
      type: "module",
    }),
});

export function getClaimProver(): Prover {
  return _prover;
}
