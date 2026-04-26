/** Worker-safe so the same wrapper works inside `*-worker.ts`; only
 *  the main thread carries `window`, so the default reporter is gated
 *  behind it. Workers can override the reporter via `setProveReporter`
 *  to relay timings back to the main thread. */

export type ZkCircuit =
  | "authorize"
  | "cancel"
  | "claim"
  | "deposit"
  | "withdraw";

export interface ProveTiming {
  circuit: ZkCircuit;
  /** Raw float — sub-ms precision retained so the same hook can time
   *  fast ops (hashing, witness-only) later without lossy rounding here. */
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

/** True in dev/test environments. Workers don't have `process` unless
 *  the bundler shims it, and `globalThis.process?.env?.NODE_ENV` is
 *  the safe read. The console fallback is silenced in production
 *  bundles where this evaluates to `false`. */
function isDev(): boolean {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } })
    .process?.env?.NODE_ENV;
  return env !== "production";
}

export async function timeProve<T>(
  circuit: ZkCircuit,
  run: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  let ok = false;
  try {
    const result = await run();
    ok = true;
    return result;
  } finally {
    const durationMs = performance.now() - t0;
    if (isDev()) {
      const tag = ok ? "ok" : "fail";
      // eslint-disable-next-line no-console
      console.log(`[zk-perf] ${circuit} prove (${tag}): ${durationMs.toFixed(1)}ms`);
    }
    reporter({ circuit, durationMs, ok });
  }
}

declare global {
  interface WindowEventMap {
    "zk-perf:prove": CustomEvent<ProveTiming>;
  }
}
