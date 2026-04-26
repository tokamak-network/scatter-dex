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

/** True only when the bundler explicitly stamps `NODE_ENV` to a dev
 *  value. Worker bundles often have no `process` shim at all (read
 *  resolves to `undefined`); treating that as dev would leak console
 *  logs into production. We require an explicit `development` /
 *  `test` value, so the absence-of-shim case stays silent. */
function isDev(): boolean {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } })
    .process?.env?.NODE_ENV;
  return env === "development" || env === "test";
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
