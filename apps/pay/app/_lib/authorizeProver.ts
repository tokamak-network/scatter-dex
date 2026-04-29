"use client";

import { createLazyWorkerProver, type Prover } from "@zkscatter/sdk/zk";

const _prover = createLazyWorkerProver({
  circuit: "authorize",
  createWorker: () =>
    new Worker(new URL("../workers/authorize.worker.ts", import.meta.url), {
      type: "module",
    }),
});

export function getAuthorizeProver(): Prover {
  return _prover;
}
