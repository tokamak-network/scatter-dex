"use client";

import { createLazyWorkerProver } from "@zkscatter/sdk/zk";

export const depositProver = createLazyWorkerProver({
  circuit: "deposit",
  createWorker: () =>
    new Worker(new URL("../workers/deposit.worker.ts", import.meta.url), {
      type: "module",
    }),
});
