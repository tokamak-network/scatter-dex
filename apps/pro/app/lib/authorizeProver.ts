"use client";

import { createMockProver, type Prover } from "@zkscatter/sdk/zk";

/** Single shared prover instance for the authorize (limit-order) flow.
 *
 *  Phase 3c uses `createMockProver` so the order UX is demonstrable
 *  without (a) shipping the 24 MB authorize circuit assets to the
 *  app's `public/zk/` and (b) wiring a Web Worker file. Both happen
 *  in Phase 3d — at which point this file becomes:
 *
 *  ```ts
 *  return createWebWorkerProver({
 *    createWorker: () =>
 *      new Worker(new URL("../workers/authorize.worker.ts", import.meta.url),
 *                 { type: "module" }),
 *  });
 *  ```
 *
 *  `OrderModal` is unchanged by that swap. The 3 s mock latency
 *  matches the real circuit's ~1–2 s (desktop) / ~5–9 s (mobile)
 *  range so progress UX is roughly proportional. */
let _prover: Prover | null = null;

export function getAuthorizeProver(): Prover {
  if (!_prover) {
    _prover = createMockProver({ latencyMs: 3000, publicSignalsCount: 15 });
  }
  return _prover;
}
