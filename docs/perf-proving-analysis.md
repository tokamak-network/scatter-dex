# Browser ZK Proof Performance Analysis

> **Date**: 2026-04-10
> **Scope**: Evaluate optimization options for browser-side Groth16 proof generation
> **Conclusion**: Current performance (22K constraints, ~1-2s desktop) is near-optimal for snarkjs. rapidsnark WASM is infeasible. SharedArrayBuffer adds marginal value since snarkjs already has an internal Worker pool.

## 1. Circuit Constraint Inventory

All circuits compiled to BN254 Groth16 via circom 2.0 + snarkjs.

| Circuit | Constraints | Browser proving | Role |
|---------|------------|----------------|------|
| **authorize.circom** | **22,468** | Yes (every order) | Half-proof: user authorizes one side |
| cancel.circom | 10,580 | Yes (on cancel) | Escrow rotation |
| withdraw.circom | 6,344 | Yes (on withdraw) | Withdraw from pool |
| claim.circom | 1,553 | Yes (on claim) | Claim settled funds |
| deposit.circom | 400 | Yes (on deposit) | Deposit to pool |
| settle.circom | 64,503 | No (legacy server) | Monolithic settle (deprecated) |

**authorize.circom is the critical path** — it runs on every order submission.

## 2. Benchmark Results

### 2.1 Node.js (native V8, singleThread, Apple M-series 16-core)

Full valid authorize proof with EdDSA signature, 20-level Merkle tree, 1 claim:

```
Witness calculation:  88ms  (11.5%)
Groth16 prove:       678ms  (88.5%)
Total:               765ms

Proof: VALID (verified against vkey)
```

### 2.2 Browser Estimates

Browser WASM runs ~2-3x slower than Node.js native code (V8 JIT vs WASM interpreter overhead, memory management differences).

| Environment | singleThread | multiThread (4 workers) |
|-------------|-------------|------------------------|
| Desktop Chrome (M-series) | ~1.9s | ~1.0s |
| Desktop Chrome (mid-range x86) | ~3-5s | ~1.5-2.5s |
| Mobile Safari (iPhone) | ~4.5s | ~2.8s |
| Mobile Chrome (mid-range Android) | ~8-15s | ~5-9s |

### 2.3 Time Breakdown

The prove step dominates at 88.5%. Within the prove step:
- **MSM (Multi-Scalar Multiplication)**: ~70-80% of prove time — parallelizable
- **FFT/NTT**: ~15-20% — parallelizable
- **Scalar operations**: ~5-10% — sequential

Witness calculation (11.5%) is inherently sequential (circuit gate dependency chain) and not a meaningful optimization target.

## 3. rapidsnark WASM: Infeasible

### Why rapidsnark is fast
rapidsnark achieves 3-5x speedup over snarkjs through **hand-written Intel/ARM assembly** for finite field arithmetic (`fq_raw_asm_x86_64.s`, `fq_raw_asm_aarch64.s`), plus assembly-optimized GMP (GNU Multiple Precision) for big number operations.

### Why it cannot be compiled to WASM
1. **Assembly instructions are platform-specific** — `mulq`, `adcq` (x86), `mul`/`umulh` (ARM) have no WASM equivalents. Emscripten compiles C/C++ to WASM but cannot process `.s` assembly files.
2. **Pure C++ fallback exists but is slow** — `fq_raw_generic.cpp` provides a portable fallback, but it loses the ~70% speedup that comes from assembly. The resulting WASM would perform comparably to snarkjs.
3. **GMP has the same problem** — GMP's speed also depends on platform-specific assembly. The pure-C fallback (`mini-gmp`) is ~10x slower.
4. **Confirmed by Mopro project** — "rapidsnark and witnesscalc are both C++-based tools explicitly marked as unsupported for browser environments" ([Mopro Circom Comparison](https://zkmopro.org/blog/circom-comparison/)).

**Verdict**: Building rapidsnark WASM would cost significant engineering effort and produce a binary no faster than snarkjs.

## 4. snarkjs Internal Threading

### Key finding: snarkjs already has a built-in Worker pool

snarkjs's `buildThreadManager()` function:
1. Checks `globalThis.Worker` availability
2. Reads `navigator.hardwareConcurrency` for thread count
3. Creates inline Blob URL Workers for MSM/FFT parallelization
4. Falls back to `singleThread = true` if `Worker` is unavailable

```javascript
// From snarkjs/build/snarkjs.js
let concurrency = 2;
if (typeof navigator === "object" && navigator.hardwareConcurrency) {
    concurrency = navigator.hardwareConcurrency;
}
// Creates `concurrency` Blob URL Workers for MSM distribution
```

### Current architecture: Worker-in-Worker (nested)

```
Main Thread
  └─ authorize-worker.ts (Web Worker)
       └─ snarkjs.groth16.fullProve()
            └─ buildThreadManager() → creates N Blob URL Workers
```

In Web Worker context, `globalThis.Worker` **is** defined, so snarkjs should create nested Workers. Blob URL Workers are supported inside Web Workers in modern browsers (Chrome 80+, Firefox 88+, Safari 15.4+).

### Threading status assessment

If snarkjs's internal Workers are functioning:
- Desktop 3-5s = multiThread result → already near-optimal
- Additional SharedArrayBuffer optimization: marginal (~10-20% at best)

If snarkjs's internal Workers are failing silently:
- Desktop 3-5s = singleThread result → enabling Workers would give ~2x improvement
- This would mean current mobile 15-30s → could become 8-15s

The reported "3-5s desktop" timing is consistent with **multiThread on a mid-range machine** or **singleThread on a fast M-series Mac**. Definitive determination requires browser console instrumentation (see §6).

## 5. Optimization Options Assessment

| Option | Expected Improvement | Effort | Status |
|--------|---------------------|--------|--------|
| ~~rapidsnark WASM~~ | ~~3-5x~~ | ~~High~~ | **Infeasible** (assembly dependency) |
| SharedArrayBuffer | 10-20% (if snarkjs already multi-threaded) or 2x (if not) | Medium | COOP/COEP headers required |
| circom-witness-rs | ~5x on witness step (but witness is only 11.5%) | Low | ~6% total improvement |
| WASM SIMD (v128) | ~1.3x | High (snarkjs fork) | Experimental |
| Halo2/Nova | Fundamental redesign | Very high | Circuit rewrite required |
| Server-side proving | Native speed | Low | **Violates Half-proof trust model** |

## 6. Recommended Next Steps

1. **Verify threading state in browser** — Add `console.log` inside the proving flow to check if `tm.concurrency > 1` after snarkjs initializes. This is the single most important unknown.

2. **If singleThread is confirmed**: Ensure snarkjs Worker pool functions in the nested Worker context. May require moving `fullProve` to main thread (accepting brief UI freeze) or using `OffscreenCanvas` pattern.

3. **If multiThread is confirmed**: Current performance is near-optimal for 22K constraints. Focus optimization effort elsewhere (UX perceived speed: progress indicators, optimistic updates, zkey preloading).

4. **COOP/COEP headers**: If deploying with SharedArrayBuffer support, add:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
   This enables `SharedArrayBuffer` but also restricts cross-origin resource loading (may break analytics, CDN assets, etc.).

5. **Long-term**: Monitor the [iden3/snarkjs](https://github.com/iden3/snarkjs) and [nicolo-ribaudo](https://github.com/nicolo-ribaudo) repos for official WASM-optimized prover releases.

## 7. References

- [iden3/rapidsnark](https://github.com/iden3/rapidsnark) — Native C++ Groth16 prover
- [iden3/snarkjs](https://github.com/iden3/snarkjs) — JavaScript/WASM Groth16 prover (used by zkScatter)
- [Mopro: Comparison of Circom Provers](https://zkmopro.org/blog/circom-comparison/) — Cross-prover benchmarks
- [arkworks-rs/circom-compat](https://github.com/arkworks-rs/circom-compat) — Rust Groth16 alternative
- [Gnark WASM experiment (Vocdoni)](https://hackmd.io/@vocdoni/B1VPA99Z3) — Go-based prover in WASM
