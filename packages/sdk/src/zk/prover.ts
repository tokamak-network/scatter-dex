import type { ProveOpts, ProveRequest, ProveResult } from "./types";

/** Generates Groth16 proofs.
 *
 *  Implementations:
 *  - `createWebWorkerProver` (browser) — runs snarkjs in a Web Worker
 *    so 30-second proofs don't freeze the UI.
 *  - `createMockProver` (dev/test) — returns deterministic dummy
 *    proofs so UI flows can be exercised without circuit assets.
 *  - `createWebViewProver` (mobile, planned) — bridges to a
 *    React Native WebView running the same snarkjs build.
 *
 *  The interface is deliberately minimal: callers don't care which
 *  platform is producing the proof, only that they get one back. */
export interface Prover {
  /** Resolve once the prover is ready to accept jobs (circuits
   *  loaded, worker spawned, etc.). Idempotent: subsequent calls
   *  return the same promise. */
  ready(): Promise<void>;

  /** Generate one proof. Concurrent calls are serialized by every
   *  built-in implementation — proving is CPU-heavy and parallel
   *  jobs would just thrash. */
  prove(req: ProveRequest, opts?: ProveOpts): Promise<ProveResult>;

  /** Release any worker / WebView / circuit memory. The prover is
   *  unusable after this. Calling twice is a no-op. */
  dispose(): void;
}
