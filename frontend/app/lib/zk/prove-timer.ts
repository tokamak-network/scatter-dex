// Worker-safe so the same wrapper works inside `authorize-worker.ts`;
// only the main thread carries `window`, so dispatch is gated behind it.

export type ZkCircuit = "authorize" | "cancel" | "claim" | "deposit" | "withdraw";

export interface ProveTiming {
  circuit: ZkCircuit;
  // Raw float — sub-ms precision retained so the same hook can time fast
  // ops (hashing, witness-only) later without lossy rounding here.
  durationMs: number;
  ok: boolean;
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
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent<ProveTiming>("zk-perf:prove", {
          detail: { circuit, durationMs, ok },
        }),
      );
    }
  }
}
