import type { Prover } from "./prover";
import type { ProveOpts, ProveRequest, ProveResult } from "./types";

/** Wire-format messages exchanged with a prover Web Worker.
 *
 *  The worker side is **not** part of this SDK — each Phase 2b+
 *  circuit module ships its own worker that responds to these
 *  messages. The split keeps circuit-specific snarkjs code (large
 *  wasm, per-circuit input shapes) out of any bundle that doesn't
 *  use it. */
export type ProverWorkerRequest = {
  type: "prove";
  jobId: number;
  circuitId: string;
  input: Record<string, unknown>;
};

export type ProverWorkerResponse =
  | {
      type: "ready";
    }
  | {
      type: "progress";
      jobId: number;
      message: string;
    }
  | {
      type: "result";
      jobId: number;
      // Serialized as strings on the wire (BigInts don't survive
      // structuredClone in every browser/runtime); the client
      // decodes back to BigInt.
      proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };
      publicSignals: string[];
    }
  | {
      type: "error";
      jobId: number;
      message: string;
    };

export interface WebWorkerProverOpts {
  /** Factory for the worker. Lazy so we don't spawn until the first
   *  prove call. */
  createWorker: () => Worker;
  /** Optional logger label used in fallback warnings. */
  label?: string;
  /** Main-thread fallback when the Worker constructor throws (most
   *  often: SSR, COOP/COEP misconfiguration, very old browsers).
   *  Without one, the prover surfaces the worker error to the
   *  caller. */
  fallbackProve?: (req: ProveRequest, opts?: ProveOpts) => Promise<ProveResult>;
}

/** Build a `Prover` backed by a Web Worker. Concurrent `prove`
 *  calls are serialized — proving is CPU-bound, so parallel jobs
 *  would just contend.
 *
 *  Cancellation: the AbortSignal terminates the worker (cheapest
 *  way to stop snarkjs mid-flight) and reopens it on the next call. */
export function createWebWorkerProver(opts: WebWorkerProverOpts): Prover {
  const label = opts.label ?? "webWorkerProver";
  let worker: Worker | null = null;
  let workerFailed = false;
  let inFlight: Promise<ProveResult> | null = null;
  let nextJobId = 1;
  let disposed = false;

  function getWorker(): Worker | null {
    if (disposed) return null;
    if (workerFailed) return null;
    if (worker) return worker;
    try {
      worker = opts.createWorker();
      return worker;
    } catch (e) {
      console.warn(
        `[${label}] Web Worker creation failed; ${
          opts.fallbackProve ? "falling back to main-thread prover" : "no fallback set"
        }.`,
        e,
      );
      workerFailed = true;
      return null;
    }
  }

  function tearDown() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  async function doProve(
    req: ProveRequest,
    callOpts: ProveOpts | undefined,
  ): Promise<ProveResult> {
    const w = getWorker();
    if (!w) {
      if (opts.fallbackProve) return opts.fallbackProve(req, callOpts);
      throw new Error(`[${label}] no worker and no fallbackProve`);
    }

    const jobId = nextJobId++;

    return new Promise<ProveResult>((resolve, reject) => {
      const onMessage = (ev: MessageEvent<ProverWorkerResponse>) => {
        const msg = ev.data;
        if (msg.type === "progress" && msg.jobId === jobId) {
          callOpts?.onProgress?.(msg.message);
          return;
        }
        if (msg.type === "result" && msg.jobId === jobId) {
          settle();
          resolve({
            proof: {
              a: [BigInt(msg.proof.a[0]), BigInt(msg.proof.a[1])],
              b: [
                [BigInt(msg.proof.b[0][0]), BigInt(msg.proof.b[0][1])],
                [BigInt(msg.proof.b[1][0]), BigInt(msg.proof.b[1][1])],
              ],
              c: [BigInt(msg.proof.c[0]), BigInt(msg.proof.c[1])],
            },
            publicSignals: msg.publicSignals.map((s) => BigInt(s)),
          });
          return;
        }
        if (msg.type === "error" && msg.jobId === jobId) {
          settle();
          reject(new Error(`[${label}] ${msg.message}`));
          return;
        }
      };

      const onError = (ev: ErrorEvent) => {
        settle();
        reject(new Error(`[${label}] worker error: ${ev.message || "unknown"}`));
      };

      const onAbort = () => {
        settle();
        // Terminate so the worker stops crunching; next prove() spawns
        // a fresh one.
        tearDown();
        reject(new DOMException("Aborted", "AbortError"));
      };

      function settle() {
        w!.removeEventListener("message", onMessage);
        w!.removeEventListener("error", onError);
        callOpts?.signal?.removeEventListener("abort", onAbort);
      }

      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);
      callOpts?.signal?.addEventListener("abort", onAbort, { once: true });

      const reqMsg: ProverWorkerRequest = {
        type: "prove",
        jobId,
        circuitId: req.circuitId,
        input: req.input,
      };
      w.postMessage(reqMsg);
    });
  }

  return {
    async ready() {
      if (disposed) throw new Error(`[${label}] disposed`);
      // Worker spin-up is lazy; readiness is "we can spawn one".
      // Per-circuit assets load inside the worker on first prove.
    },
    async prove(req, callOpts) {
      if (disposed) throw new Error(`[${label}] disposed`);
      if (inFlight) {
        // Single-flight queue. Swallow the previous job's failure so
        // it doesn't poison the next caller.
        try {
          await inFlight;
        } catch {
          /* prior call failure is the prior caller's problem */
        }
      }
      const promise = doProve(req, callOpts);
      inFlight = promise;
      try {
        return await promise;
      } finally {
        if (inFlight === promise) inFlight = null;
      }
    },
    dispose() {
      disposed = true;
      tearDown();
    },
  };
}
