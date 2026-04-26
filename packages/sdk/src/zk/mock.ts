import type { Prover } from "./prover";
import type { Groth16Proof, ProveOpts, ProveRequest, ProveResult } from "./types";

export interface MockProverOpts {
  /** Latency for each `prove` call (ms). Defaults to 50 — enough
   *  to make spinners visible in tests without slowing them down. */
  latencyMs?: number;
  /** Number of public signals to return per proof. Tests that
   *  inspect the count can override; default is one (the most
   *  common circuit shape). */
  publicSignalsCount?: number;
}

/** A `Prover` that returns deterministic dummy proofs after a small
 *  delay. Useful for:
 *  - exercising UI flows without shipping circuit assets
 *  - integration tests that don't want to set up snarkjs
 *  - storybooks / visual regression
 *
 *  The returned proof is structurally valid (BigInts in the right
 *  shape) but cryptographically nonsense. Verifiers will reject it. */
export function createMockProver(opts: MockProverOpts = {}): Prover {
  const latency = opts.latencyMs ?? 50;
  const signalsCount = Math.max(0, opts.publicSignalsCount ?? 1);
  let disposed = false;

  return {
    async ready() {
      if (disposed) throw new Error("MockProver disposed");
    },
    async prove(req: ProveRequest, callOpts?: ProveOpts): Promise<ProveResult> {
      if (disposed) throw new Error("MockProver disposed");
      callOpts?.onProgress?.("mock: starting");
      await sleepWithSignal(latency, callOpts?.signal);
      callOpts?.onProgress?.("mock: done");
      return {
        proof: dummyProof(req.circuitId),
        publicSignals: Array.from({ length: signalsCount }, (_, i) => BigInt(i + 1)),
      };
    },
    dispose() {
      disposed = true;
    },
  };
}

function dummyProof(circuitId: string): Groth16Proof {
  // Derive a stable byte from the circuit id so different circuits
  // produce visibly different (but still bogus) proofs in tests.
  const seed = BigInt(circuitId.length || 1);
  return {
    a: [seed, seed + 1n],
    b: [
      [seed + 2n, seed + 3n],
      [seed + 4n, seed + 5n],
    ],
    c: [seed + 6n, seed + 7n],
  };
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
