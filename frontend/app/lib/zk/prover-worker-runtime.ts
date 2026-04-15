export interface WorkerHandlers<I, O> {
  deserializeInput: (raw: Record<string, unknown>) => I;
  prove: (input: I) => Promise<O>;
  serializeOutput: (out: O) => Record<string, unknown>;
  // Cleanup errors are swallowed so a wipe failure cannot mask the real
  // result/error returned to the main thread.
  cleanup?: (input: I, raw: Record<string, unknown>) => Promise<void> | void;
  // Pre-warm dynamic imports while the worker boots so the first proof
  // doesn't pay the snarkjs/circomlibjs module-graph resolution cost
  // (~100-300ms, see authorize-worker history).
  preload?: () => Promise<unknown>;
}

export function setupProverWorker<I, O>(handlers: WorkerHandlers<I, O>): void {
  const ctx = self as unknown as Worker;

  // Workers have no `window`, so the default `prove-timer` reporter
  // would silently drop CustomEvents. Relay timings via postMessage; the
  // client re-dispatches them on `window`. Catch import failure so it
  // doesn't surface as an unhandled rejection (which can terminate the
  // worker in strict environments).
  void import("./prove-timer")
    .then(({ setProveReporter }) => {
      setProveReporter((timing) => ctx.postMessage({ type: "perf", timing }));
    })
    .catch((err: unknown) => {
      console.warn("[prover-worker] prove-timer init failed:", err);
    });

  void handlers.preload?.().catch((err: unknown) => {
    console.warn("[prover-worker] preload failed:", err);
  });

  ctx.onmessage = async (event: MessageEvent) => {
    let input: I | undefined;
    try {
      input = handlers.deserializeInput(event.data);
      const result = await handlers.prove(input);
      ctx.postMessage({ type: "result", data: handlers.serializeOutput(result) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.postMessage({ type: "error", message });
    } finally {
      try {
        if (input !== undefined && handlers.cleanup) {
          await handlers.cleanup(input, event.data);
        }
      } catch {
        /* best-effort */
      }
    }
  };
}
