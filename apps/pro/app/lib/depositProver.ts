"use client";

import { createLazyWorkerProver, type Prover } from "@zkscatter/sdk/zk";

const _prover = createLazyWorkerProver({
  circuit: "deposit",
  createWorker: () =>
    new Worker(new URL("../workers/deposit.worker.ts", import.meta.url), {
      type: "module",
    }),
});

export function getDepositProver(): Prover {
  return _prover;
}
