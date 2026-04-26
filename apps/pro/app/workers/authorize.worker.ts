/// <reference lib="webworker" />
//
// Web Worker that runs the authorize-circuit prover off the main
// thread. snarkjs.fullProve takes 1–2 s on desktop / 5–9 s on
// mobile and would freeze React if it ran inline.

import {
  generateAuthorizeProof,
  setupProverWorker,
  warmProverAssets,
  warmupEddsa,
  withCachedAssets,
  type AuthorizeProofInput,
} from "@zkscatter/sdk/zk";

const CIRCUIT_ASSETS = {
  wasm: "/zk/authorize.wasm",
  zkey: "/zk/authorize_final.zkey",
} as const;

// Timing telemetry for the prove step lives on the main thread side
// (around `prover.prove()`), where `window` exists and the default
// `proveTimer` reporter can dispatch the `zk-perf:prove` event. Doing
// it here would silently drop the event because workers have no
// `window`. The main-thread wrapper measures end-to-end including
// the postMessage round-trip — for 1–9 s proves the extra few ms is
// in the noise.

setupProverWorker({
  // Build Poseidon + EdDSA / Babyjub singletons AND prefetch
  // wasm/zkey into the IDB cache before announcing readiness. Without
  // this the first prove pays the ~50–150 ms table-build cost AND the
  // ~24 MB asset fetch on the user's hot path.
  preload: async () => {
    await Promise.all([warmProverAssets(CIRCUIT_ASSETS), warmupEddsa()]);
  },

  prove: async (req) => {
    if (req.circuitId !== "authorize") {
      throw new Error(
        `authorize.worker: refusing circuitId=${req.circuitId}; this worker only handles "authorize"`,
      );
    }

    const input = req.input as unknown as AuthorizeProofInput;

    return withCachedAssets(CIRCUIT_ASSETS, async (urls) => {
      const result = await generateAuthorizeProof(input, urls);
      return { proof: result.proof, publicSignals: result.publicSignals };
    });
  },
});
