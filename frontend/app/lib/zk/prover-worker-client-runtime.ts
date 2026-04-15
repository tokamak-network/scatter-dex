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

export interface ProverWorkerClient<I, O> {
  prove(input: I): Promise<O>;
  terminate(): void;
}

export function createProverWorkerClient<I, O>(
  handlers: ClientHandlers<I, O>,
): ProverWorkerClient<I, O> {
  let worker: Worker | null = null;
  let workerFailed = false;
  let inFlight: Promise<O> | null = null;

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
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === "perf") {
          const timing = event.data.timing as ProveTiming;
          window.dispatchEvent(
            new CustomEvent<ProveTiming>("zk-perf:prove", { detail: timing }),
          );
          return;
        }
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        if (event.data.type === "error") {
          reject(new Error(event.data.message));
          return;
        }
        resolve(handlers.deserializeOutput(event.data.data));
      };

      const onError = (err: ErrorEvent) => {
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
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
      const serialized = handlers.serializeInput(input);
      w.postMessage(serialized);
      handlers.wipeSerialized?.(serialized);
    });
  }

  function terminate(): void {
    worker?.terminate();
    worker = null;
  }

  return { prove, terminate };
}
