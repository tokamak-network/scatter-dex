"use client";

import { createLazyWorkerProver } from "@zkscatter/sdk/zk";

export const claimProver = createLazyWorkerProver({
  circuit: "claim",
  createWorker: () =>
    new Worker(new URL("../workers/claim.worker.ts", import.meta.url), {
      type: "module",
    }),
});
