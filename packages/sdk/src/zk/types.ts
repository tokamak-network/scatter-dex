/** Identifier for a Groth16 circuit shipped with the protocol.
 *  String literal union (not enum) so consumers can extend it via
 *  declaration merging if they ship private circuits. */
export type CircuitId = "deposit" | "authorize" | "claim" | (string & {});

/** Groth16 proof in the shape every Solidity verifier expects:
 *  two G1 elements (a, c) and one G2 element (b). Tuples — not
 *  arrays — so positional access is type-checked at call sites. */
export interface Groth16Proof {
  a: readonly [bigint, bigint];
  b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  c: readonly [bigint, bigint];
}

/** Output of one proof job. `publicSignals` carries the public
 *  inputs in circuit-declared order so callers can splice them into
 *  the verifier call. */
export interface ProveResult {
  proof: Groth16Proof;
  publicSignals: readonly bigint[];
}

/** Optional knobs for a single prove call. Every implementation must
 *  honor `signal` for cancellation; `onProgress` is best-effort. */
export interface ProveOpts {
  /** Cancel the proof job. The returned promise rejects with a
   *  DOMException("AbortError") when fired. */
  signal?: AbortSignal;
  /** Called with short status strings ("loading wasm", "running
   *  groth16…"). Surfaces are free to ignore. */
  onProgress?: (msg: string) => void;
}

/** A request to generate one proof. The `input` shape is per-circuit
 *  and validated by the implementation; this layer only carries it. */
export interface ProveRequest {
  circuitId: CircuitId;
  /** Field-by-field circuit input. BigInts are accepted directly
   *  for prime-field values; strings/numbers are coerced by the
   *  implementation. Concrete shapes are exposed by per-circuit
   *  helpers in higher-level modules (e.g. `zk/deposit`). */
  input: Record<string, unknown>;
}
