"use client";

import { createLazyWorkerProver } from "@zkscatter/sdk/zk";

export const cancelProver = createLazyWorkerProver({
  circuit: "cancel",
  createWorker: () =>
    new Worker(new URL("../workers/cancel.worker.ts", import.meta.url), {
      type: "module",
    }),
});
