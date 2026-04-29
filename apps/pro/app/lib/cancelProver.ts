"use client";

import { createLazyWorkerProver, type Prover } from "@zkscatter/sdk/zk";

const _prover = createLazyWorkerProver({
  circuit: "cancel",
  createWorker: () =>
    new Worker(new URL("../workers/cancel.worker.ts", import.meta.url), {
      type: "module",
    }),
});

export function getCancelProver(): Prover {
  return _prover;
}
