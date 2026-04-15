import type { ProveTiming } from "./prove-timer";

export interface ClientHandlers<I, O> {
  workerUrl: URL;
  label: string;
  serializeInput: (input: I) => Record<string, unknown>;
  deserializeOutput: (raw: Record<string, unknown>) => O;
  fallbackProve: (input: I) => Promise<O>;
  // Wipe sensitive copies in the serialised payload (e.g., array form of
  // a private key). The structuredClone for postMessage has already been
  // taken at this point, so mutating the source copy doesn't reach the
  // worker but does shorten the lifetime of the secret in main-heap GC.
  wipeSerialized?: (serialized: Record<string, unknown>) => void;
}

export interface TerminateOptions {
  // When set, an in-flight prove call's promise is dropped (orphaned for
  // GC) instead of rejected. Used by page-unmount cleanup so the page's
  // catch handler doesn't fire `setState` on an unmounted component.
  silent?: boolean;
}

export interface ProverWorkerClient<I, O> {
  prove(input: I): Promise<O>;
  terminate(options?: TerminateOptions): void;
}

export function createProverWorkerClient<I, O>(
  handlers: ClientHandlers<I, O>,
): ProverWorkerClient<I, O> {
  let worker: Worker | null = null;
  let workerFailed = false;
  let inFlight: Promise<O> | null = null;
  // Captured so `terminate` can settle the active promise instead of
  // leaving callers — and the single-flight queue — hung indefinitely.
  let activeReject: ((err: Error) => void) | null = null;

  function getWorker(): Worker | null {
    if (workerFailed) return null;
    if (worker) return worker;
    try {
      worker = new Worker(handlers.workerUrl, { type: "module" });
      return worker;
    } catch {
      console.warn(
        `[${handlers.label}] Web Worker creation failed. ` +
          `Falling back to main-thread proof generation (UI may freeze).`,
      );
      workerFailed = true;
      return null;
    }
  }

  async function prove(input: I): Promise<O> {
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* ignore previous-call failure */
      }
    }
    const promise = doProve(input);
    inFlight = promise;
    try {
      return await promise;
    } finally {
      if (inFlight === promise) inFlight = null;
    }
  }

  async function doProve(input: I): Promise<O> {
    const w = getWorker();
    if (!w) return handlers.fallbackProve(input);

    return new Promise<O>((resolve, reject) => {
      activeReject = reject;
      const settle = () => {
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        if (activeReject === reject) activeReject = null;
      };

      const onMessage = (event: MessageEvent) => {
        const data = event.data;
        if (data?.type === "perf") {
          const timing = data.timing as ProveTiming;
          window.dispatchEvent(
            new CustomEvent<ProveTiming>("zk-perf:prove", { detail: timing }),
          );
          return;
        }
        settle();
        if (data?.type === "error") {
          reject(new Error(data.message));
          return;
        }
        if (data?.type === "result") {
          resolve(handlers.deserializeOutput(data.data));
          return;
        }
        reject(new Error(`[${handlers.label}] Unexpected worker message format`));
      };

      const onError = (err: ErrorEvent) => {
        settle();
        // Worker-level crash (OOM, module load failure, missing feature).
        // Burn the worker so all subsequent calls fall back to main thread.
        console.warn(
          `[${handlers.label}] Worker error — terminating and falling back.`,
          err.message,
        );
        worker?.terminate();
        worker = null;
        workerFailed = true;
        reject(new Error(`Worker error: ${err.message}`));
      };

      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);

      // Serialize/postMessage can throw (e.g., DataCloneError on a value
      // that structuredClone can't carry). Settle and reject so the
      // listeners we just attached don't leak.
      try {
        const serialized = handlers.serializeInput(input);
        w.postMessage(serialized);
        handlers.wipeSerialized?.(serialized);
      } catch (err: unknown) {
        settle();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function terminate(options?: TerminateOptions): void {
    worker?.terminate();
    worker = null;
    // Always clear the single-flight slot. Without this, a silent
    // terminate would orphan the in-flight promise (which now never
    // settles, since the worker is gone) and the next `prove()` call
    // would `await inFlight` forever — see PR #344 review #3085975266.
    inFlight = null;
    if (!activeReject) return;
    const reject = activeReject;
    activeReject = null;
    if (!options?.silent) {
      reject(new Error(`[${handlers.label}] Worker terminated mid-proof`));
    }
    // silent: drop the reject reference, let the orphaned promise GC.
  }

  return { prove, terminate };
}
