import type { CircuitTier } from "./constants";
import type { Prover } from "./prover";
import { wrapProverWithTimer, type ZkCircuit } from "./proveTimer";
import type { Groth16Proof, ProveOpts, ProveRequest, ProveResult } from "./types";

/** Wire-format messages exchanged with a prover Web Worker.
 *
 *  The worker side is **not** part of this SDK — each Phase 2b+
 *  circuit module ships its own worker that responds to these
 *  messages. The split keeps circuit-specific snarkjs code (large
 *  wasm, per-circuit input shapes) out of any bundle that doesn't
 *  use it.
 *
 *  BigInts cross the boundary as native BigInt values. The
 *  HTML structuredClone algorithm has supported BigInt across all
 *  browsers and Node ≥ 17 for years, so the older string-encoding
 *  workaround is unnecessary and just slowed proofs down. */
export type ProverWorkerRequest = {
  type: "prove";
  jobId: number;
  circuitId: string;
  input: Record<string, unknown>;
  /** Optional circuit tier hint. {@link CircuitTier} is a plain data
   *  object (no methods), so it survives `postMessage`'s structured
   *  clone unchanged. Worker handlers default to TIER_16 when omitted,
   *  preserving the single-tier behavior pre-multi-tier callers expect. */
  tier?: CircuitTier;
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
      proof: Groth16Proof;
      publicSignals: readonly bigint[];
      /** See `ProveResult.meta`. */
      meta?: Readonly<Record<string, bigint>>;
    }
  | {
      type: "error";
      jobId: number;
      message: string;
    };

export interface WebWorkerProverOpts {
  /** Factory for the worker. Lazy so we don't spawn until the first
   *  prove (or `ready()`) call. */
  createWorker: () => Worker;
  /** Optional logger label used in fallback warnings and errors. */
  label?: string;
  /** Main-thread fallback when the Worker constructor throws (most
   *  often: SSR, COOP/COEP misconfiguration, very old browsers).
   *  Without one, the prover surfaces the worker error to the
   *  caller. */
  fallbackProve?: (req: ProveRequest, opts?: ProveOpts) => Promise<ProveResult>;
}

interface QueueEntry {
  req: ProveRequest;
  opts: ProveOpts | undefined;
  resolve: (r: ProveResult) => void;
  reject: (e: Error) => void;
  /** Listener registered against opts.signal so we can detach on
   *  settle / dequeue. */
  onAbort?: () => void;
}

/** Build a `Prover` backed by a Web Worker.
 *
 *  Concurrency: jobs are processed strictly in order. Calling
 *  `prove()` while another job is in flight enqueues the new
 *  request — no parallel execution (proving is CPU-bound; parallel
 *  jobs would just contend) and no thundering-herd wake-up.
 *
 *  Cancellation: an aborted `signal` rejects immediately whether
 *  the job is queued or running. A running job's worker is
 *  terminated (cheapest way to stop snarkjs mid-flight) and a
 *  fresh one spawns on the next call.
 *
 *  Worker errors: a runtime error from the worker tears down the
 *  instance — the worker is often in a bad state after an error
 *  and reusing it produces unpredictable failures. The next call
 *  spawns a fresh worker (or hits `fallbackProve`). */
export function createWebWorkerProver(opts: WebWorkerProverOpts): Prover {
  const label = opts.label ?? "webWorkerProver";
  let worker: Worker | null = null;
  let workerFailed = false;
  let disposed = false;
  let nextJobId = 1;

  /** Strict FIFO queue. The head is processed serially. */
  const queue: QueueEntry[] = [];
  let processing = false;

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

  function failAllPending(error: Error) {
    while (queue.length > 0) {
      const e = queue.shift()!;
      e.opts?.signal?.removeEventListener("abort", e.onAbort!);
      e.reject(error);
    }
  }

  function detachAbort(entry: QueueEntry) {
    if (entry.onAbort && entry.opts?.signal) {
      entry.opts.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = undefined;
    }
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        if (disposed) {
          failAllPending(new Error(`[${label}] disposed`));
          return;
        }
        const head = queue[0]!;
        // Caller may have aborted while queued — drop without ever
        // talking to the worker.
        if (head.opts?.signal?.aborted) {
          queue.shift();
          detachAbort(head);
          head.reject(new DOMException("Aborted", "AbortError"));
          continue;
        }
        try {
          const result = await runOne(head);
          // runOne handled detach + shift, just resolve.
          head.resolve(result);
        } catch (err) {
          // runOne handled detach + shift; surface the error.
          head.reject(err as Error);
        }
      }
    } finally {
      processing = false;
    }
  }

  /** Run the head entry against the worker. The entry is shifted
   *  from the queue *before* posting so subsequent dispose / abort
   *  handlers see a clean queue. */
  function runOne(entry: QueueEntry): Promise<ProveResult> {
    queue.shift();

    const w = getWorker();
    if (!w) {
      detachAbort(entry);
      if (opts.fallbackProve) {
        return opts.fallbackProve(entry.req, entry.opts);
      }
      return Promise.reject(
        new Error(`[${label}] no worker and no fallbackProve`),
      );
    }

    const jobId = nextJobId++;

    return new Promise<ProveResult>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        detachAbort(entry);
      };

      const onMessage = (ev: MessageEvent<ProverWorkerResponse>) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
        if (msg.type === "progress" && msg.jobId === jobId) {
          entry.opts?.onProgress?.(msg.message);
          return;
        }
        if (msg.type === "result" && msg.jobId === jobId) {
          settle();
          resolve({
            proof: msg.proof,
            publicSignals: msg.publicSignals,
            ...(msg.meta && { meta: msg.meta }),
          });
          return;
        }
        if (msg.type === "error" && msg.jobId === jobId) {
          // The worker reported a per-job error. Tear it down — after
          // reporting an error it's often in a poisoned state.
          settle();
          tearDown();
          reject(new Error(`[${label}] ${msg.message}`));
          return;
        }
      };

      const onError = (ev: ErrorEvent) => {
        // Runtime error from the worker scope itself (uncaught). Worker
        // is unsafe to reuse; tear it down so the next call gets a
        // fresh one (or falls back).
        settle();
        tearDown();
        reject(new Error(`[${label}] worker error: ${ev.message || "unknown"}`));
      };

      // Replace the queue-wait abort handler with a running-state one.
      detachAbort(entry);
      const onAbortDuringRun = () => {
        settle();
        // Hard-stop snarkjs: terminate the worker. Next call spawns
        // a fresh one.
        tearDown();
        reject(new DOMException("Aborted", "AbortError"));
      };
      entry.onAbort = onAbortDuringRun;
      entry.opts?.signal?.addEventListener("abort", onAbortDuringRun, { once: true });

      // Race: caller may have aborted between the queue-wait check
      // and now. Honor it before posting.
      if (entry.opts?.signal?.aborted) {
        settle();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);

      const reqMsg: ProverWorkerRequest = {
        type: "prove",
        jobId,
        circuitId: entry.req.circuitId,
        input: entry.req.input,
        ...(entry.req.tier ? { tier: entry.req.tier } : {}),
      };
      w.postMessage(reqMsg);
    });
  }

  return {
    async ready() {
      if (disposed) throw new Error(`[${label}] disposed`);
      // Surface worker-spawn failures up front — matches the Prover
      // contract that "ready" means we can actually accept jobs.
      // If no worker can be created and there's no fallback, that's
      // a hard failure.
      const w = getWorker();
      if (!w && !opts.fallbackProve) {
        throw new Error(
          `[${label}] worker creation failed and no fallbackProve set`,
        );
      }
    },
    async prove(req, callOpts) {
      if (disposed) throw new Error(`[${label}] disposed`);

      // Honor an already-aborted signal without enqueueing.
      if (callOpts?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      return new Promise<ProveResult>((resolve, reject) => {
        const entry: QueueEntry = { req, opts: callOpts, resolve, reject };

        // Wire an abort listener for the queue-wait phase. runOne
        // detaches and re-attaches with a running-state handler.
        if (callOpts?.signal) {
          entry.onAbort = () => {
            // Drop from the queue if still pending.
            const idx = queue.indexOf(entry);
            if (idx >= 0) {
              queue.splice(idx, 1);
              detachAbort(entry);
              reject(new DOMException("Aborted", "AbortError"));
            }
          };
          callOpts.signal.addEventListener("abort", entry.onAbort, { once: true });
        }

        queue.push(entry);
        // Fire-and-forget: processQueue handles its own loop and
        // resolves entries as it goes.
        void processQueue();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      tearDown();
      // Reject anything still queued so callers don't hang.
      failAllPending(new Error(`[${label}] disposed`));
    },
  };
}

export interface LazyWorkerProverOpts {
  /** Circuit name — used for the timing wrapper's label and as the
   *  `WebWorkerProverOpts.label` for fallback warnings. */
  circuit: ZkCircuit;
  /** Spawn the per-circuit worker. Lazily invoked on first
   *  `ready()` / `prove()` so apps that never use the prover don't
   *  pay the ~24 MB asset fetch. */
  createWorker: () => Worker;
}

/** Lazy-singleton authorize/claim/deposit/etc prover, wrapped with
 *  the standard timing reporter. Apps used to hand-roll this five-line
 *  pattern per circuit (`apps/pro/app/lib/{authorize,cancel,claim,
 *  deposit}Prover.ts`); this single helper supersedes them. The
 *  worker URL stays at the call site because Webpack/Turbopack
 *  resolves `import.meta.url` only when seen as a literal there. */
export function createLazyWorkerProver(opts: LazyWorkerProverOpts): Prover {
  let inner: Prover | null = null;
  let disposed = false;
  function get(): Prover {
    // Match `createWebWorkerProver`'s post-dispose contract: any
    // further use is a programming error rather than a silent
    // worker re-spawn. Without this, dispose() then prove() would
    // resurrect the prover and the timing reporter would think the
    // app shut down.
    if (disposed) {
      throw new Error(
        `[${opts.circuit}] createLazyWorkerProver: prover used after dispose()`,
      );
    }
    if (!inner) {
      inner = wrapProverWithTimer(
        opts.circuit,
        createWebWorkerProver({
          label: opts.circuit,
          createWorker: opts.createWorker,
        }),
      );
    }
    return inner;
  }
  return {
    ready: () => get().ready(),
    prove: (req, proveOpts) => get().prove(req, proveOpts),
    dispose: () => {
      // Disposing before first use is a no-op so callers can call
      // it unconditionally on app shutdown without the lazy spawn
      // firing just to be torn down. After dispose, `inner` stays
      // null and `disposed` blocks further use.
      if (disposed) return;
      disposed = true;
      if (inner) inner.dispose();
      inner = null;
    },
  };
}
