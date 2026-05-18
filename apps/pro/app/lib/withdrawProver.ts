"use client";

import { createLazyWorkerProver } from "@zkscatter/sdk/zk";

export const withdrawProver = createLazyWorkerProver({
  circuit: "withdraw",
  createWorker: () =>
    new Worker(new URL("../workers/withdraw.worker.ts", import.meta.url), {
      type: "module",
    }),
});
