// Worker-safe so the same wrapper works inside `authorize-worker.ts`;
// only the main thread carries `window`, so the default reporter is gated
// behind it. Workers can override the reporter via `setProveReporter` to
// relay timings back to the main thread (see `authorize-worker.ts`).

export type ZkCircuit = "authorize" | "cancel" | "claim" | "deposit" | "withdraw";

export interface ProveTiming {
  circuit: ZkCircuit;
  // Raw float — sub-ms precision retained so the same hook can time fast
  // ops (hashing, witness-only) later without lossy rounding here.
  durationMs: number;
  ok: boolean;
}

export type ProveReporter = (timing: ProveTiming) => void;

let reporter: ProveReporter = defaultReporter;

export function setProveReporter(fn: ProveReporter): void {
  reporter = fn;
}

function defaultReporter(timing: ProveTiming): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ProveTiming>("zk-perf:prove", { detail: timing }),
    );
  }
}

export async function timeProve<T>(circuit: ZkCircuit, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  let ok = false;
  try {
    const result = await run();
    ok = true;
    return result;
  } finally {
    const durationMs = performance.now() - t0;
    if (process.env.NODE_ENV !== "production") {
      const tag = ok ? "ok" : "fail";
      // eslint-disable-next-line no-console
      console.log(`[zk-perf] ${circuit} prove (${tag}): ${durationMs.toFixed(1)}ms`);
    }
    reporter({ circuit, durationMs, ok });
  }
}
