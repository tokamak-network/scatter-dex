import type { ProverWorkerRequest, ProverWorkerResponse } from "./webWorker";
import type { Groth16Proof } from "./types";

/** What a circuit-specific worker file plugs into `setupProverWorker`. */
export interface ProverWorkerHandlers {
  /** Run the proof for one job. May throw — the runtime turns that
   *  into a `{ type: "error" }` message back to the main thread. */
  prove(req: ProverWorkerRequest): Promise<{
    proof: Groth16Proof;
    publicSignals: readonly bigint[];
  }>;
  /** Optional asset / Poseidon warmup, run once before the worker
   *  signals "ready". Errors here propagate as a worker-scope
   *  error; the client tears down and either falls back or surfaces
   *  the error. */
  preload?(): Promise<void>;
}

/** Wire a Web Worker script to the SDK's prover protocol.
 *
 *  Usage from a circuit-specific worker file (consumer-owned):
 *
 *  ```ts
 *  // apps/<name>/workers/deposit.worker.ts
 *  import { setupProverWorker } from "@zkscatter/sdk/zk";
 *  import { generateDepositProof } from "@zkscatter/sdk/zk";
 *  import { warmupPoseidon } from "@zkscatter/sdk/zk";
 *
 *  setupProverWorker({
 *    preload: () => warmupPoseidon(),
 *    prove: (req) => generateDepositProof(req.input as never, {
 *      wasm: "/zk/deposit.wasm",
 *      zkey: "/zk/deposit.zkey",
 *    }),
 *  });
 *  ```
 *
 *  The runtime handles message decoding, error wrapping, and the
 *  initial `ready` signal. Per-job progress messages can be sent
 *  with the returned `postProgress` helper. */
export function setupProverWorker(handlers: ProverWorkerHandlers): {
  /** Send a progress message to the main thread for a job in flight.
   *  No-op outside a Web Worker context. */
  postProgress(jobId: number, message: string): void;
} {
  // Only run inside a real DedicatedWorkerGlobalScope. Importing this
  // module from the main thread is a no-op so consumers can include
  // it conditionally without crashing SSR or Jest runs.
  const scope = globalThis as unknown as {
    self?: DedicatedWorkerGlobalScope;
    postMessage?: (msg: ProverWorkerResponse) => void;
    addEventListener?: typeof addEventListener;
  };
  const post = scope.postMessage?.bind(scope);
  if (!post || typeof scope.addEventListener !== "function") {
    return { postProgress: () => {} };
  }

  // Preload, then announce readiness. If preload throws, surface as
  // a worker-scope error so the client tears down + retries.
  (async () => {
    try {
      if (handlers.preload) await handlers.preload();
      post({ type: "ready" });
    } catch (e) {
      // Re-throw on a microtask so the host's `error` handler fires.
      setTimeout(() => {
        throw e;
      }, 0);
    }
  })();

  scope.addEventListener("message", async (ev: MessageEvent<ProverWorkerRequest>) => {
    const req = ev.data;
    if (!req || typeof req !== "object" || req.type !== "prove") return;
    try {
      const result = await handlers.prove(req);
      const out: ProverWorkerResponse = {
        type: "result",
        jobId: req.jobId,
        proof: result.proof,
        publicSignals: result.publicSignals,
      };
      post(out);
    } catch (e) {
      const out: ProverWorkerResponse = {
        type: "error",
        jobId: req.jobId,
        message: (e as Error)?.message ?? "unknown prover error",
      };
      post(out);
    }
  });

  return {
    postProgress(jobId: number, message: string) {
      post({ type: "progress", jobId, message });
    },
  };
}
