"use client";

import { createLazyWorkerProver } from "@zkscatter/sdk/zk";

export const authorizeProver = createLazyWorkerProver({
  circuit: "authorize",
  createWorker: () =>
    new Worker(new URL("../workers/authorize.worker.ts", import.meta.url), {
      type: "module",
    }),
});
