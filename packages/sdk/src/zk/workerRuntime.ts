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
   *  signals "ready". Errors here are reported as a worker-scope
   *  error AND posted as a sentinel error message so the main
   *  thread surfaces a clear failure instead of waiting forever
   *  for a `ready` that never comes. */
  preload?(): Promise<void>;
}

/** Sentinel jobId used by preload-failure error messages. The main
 *  client uses this to surface init failures even when no job is
 *  in flight; a real prove jobId is always > 0. */
export const PRELOAD_ERROR_JOB_ID = -1;

/** Wire a Web Worker script to the SDK's prover protocol.
 *
 *  Usage from a circuit-specific worker file (consumer-owned):
 *
 *  ```ts
 *  // apps/<name>/workers/deposit.worker.ts
 *  import {
 *    setupProverWorker,
 *    warmupPoseidon,
 *    generateDepositProof,
 *  } from "@zkscatter/sdk/zk";
 *
 *  setupProverWorker({
 *    preload: () => warmupPoseidon(),
 *    prove: async (req) => {
 *      const { proof, publicSignals } = await generateDepositProof(
 *        req.input as never,
 *        { wasm: "/zk/deposit.wasm", zkey: "/zk/deposit.zkey" },
 *      );
 *      return { proof, publicSignals };
 *    },
 *  });
 *  ```
 *
 *  The runtime handles message decoding, request validation, and
 *  error wrapping. Per-job progress messages can be sent with the
 *  returned `postProgress` helper. */
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

  // Preload, then announce readiness. If preload throws, surface
  // the failure both as a sentinel error message (so the main thread
  // can see what went wrong) AND by re-throwing on a later task so
  // the host's `error` handler also fires — the client tears down
  // either way.
  (async () => {
    try {
      if (handlers.preload) await handlers.preload();
      post({ type: "ready" });
    } catch (e) {
      const message = (e as Error)?.message ?? "unknown preload error";
      post({ type: "error", jobId: PRELOAD_ERROR_JOB_ID, message });
      // Re-throw on a macrotask so the host's `error` handler also
      // fires — belt and suspenders.
      setTimeout(() => {
        throw e;
      }, 0);
    }
  })();

  scope.addEventListener("message", async (ev: MessageEvent<unknown>) => {
    const req = ev.data;
    // Centralized request validation — reject malformed envelopes
    // before they reach handlers. Bad input from a misbehaving
    // sender no longer produces results with NaN job ids.
    if (!isProveRequest(req)) return;
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

function isProveRequest(value: unknown): value is ProverWorkerRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "prove" &&
    typeof v.jobId === "number" &&
    Number.isFinite(v.jobId) &&
    typeof v.circuitId === "string" &&
    v.input != null &&
    typeof v.input === "object"
  );
}
