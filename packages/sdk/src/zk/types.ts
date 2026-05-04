import type { CircuitTier } from "./constants";

/** Identifier for a Groth16 circuit shipped with the protocol.
 *  Open string-literal union — the well-known names get IDE
 *  autocomplete, but any string is accepted so consumers shipping
 *  private circuits don't have to fork the SDK. (Type aliases
 *  can't be declaration-merged; widening via `(string & {})` is
 *  the workaround.) */
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
 *  the verifier call. `meta` is an optional side-channel for private
 *  outputs the worker computed but the circuit doesn't expose as a
 *  public signal — e.g. cancel's `freshSalt`, which the rotated note
 *  needs persisted client-side but the on-chain call doesn't take.
 *  Field-element values; same BigInt structuredClone path as the
 *  proof itself. Workers that don't need the channel just omit it. */
export interface ProveResult {
  proof: Groth16Proof;
  publicSignals: readonly bigint[];
  meta?: Readonly<Record<string, bigint>>;
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
  /** Optional circuit-tier hint for per-tier provers (e.g. authorize
   *  16 / 64 / 128). `CircuitTier` is a plain data object so it
   *  survives `postMessage`'s structured clone unchanged. Workers
   *  fall back to TIER_16 when omitted, preserving the historical
   *  single-tier behavior. */
  tier?: CircuitTier;
}
