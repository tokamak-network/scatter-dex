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
  timeProve,
  type AuthorizeProofInput,
} from "@zkscatter/sdk/zk";

const CIRCUIT_ASSETS = {
  wasm: "/zk/authorize.wasm",
  zkey: "/zk/authorize_final.zkey",
} as const;

setupProverWorker({
  // Build Poseidon + EdDSA / Babyjub singletons AND prefetch
  // wasm/zkey into the IDB cache before announcing readiness. Without
  // this the first prove pays the ~50–150 ms table-build cost AND the
  // ~24 MB asset fetch on the user's hot path; with it both costs
  // land during worker boot and the first prove gets the same
  // latency as the second.
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

    // `withCachedAssets` resolves wasm + zkey to Blob URLs backed by
    // IndexedDB (revalidated via ETag) so repeat proves never refetch
    // the asset bundle. `timeProve` posts a perf timing event the
    // host wires into telemetry.
    return withCachedAssets(CIRCUIT_ASSETS, (urls) =>
      timeProve("authorize", async () => {
        const result = await generateAuthorizeProof(input, urls);
        return { proof: result.proof, publicSignals: result.publicSignals };
      }),
    );
  },
});
