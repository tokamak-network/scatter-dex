/// <reference lib="webworker" />
//
// Web Worker that runs the claim-circuit prover off the main thread.
// The claim circuit verifies a single recipient's slot inside a
// settled order's claims tree and burns the per-claim nullifier on
// release. Proves in ~1–2 s desktop / 5–9 s mobile.

import {
  generateClaimProof,
  setupProverWorker,
  warmProverAssets,
  withCachedAssets,
  type ClaimProofInput,
} from "@zkscatter/sdk/zk";

const CIRCUIT_ASSETS = {
  wasm: "/zk/claim.wasm",
  zkey: "/zk/claim_final.zkey",
} as const;

// Timing telemetry runs on the main thread side — see the matching
// note in `authorize.worker.ts`.

setupProverWorker({
  preload: async () => {
    await warmProverAssets(CIRCUIT_ASSETS);
  },

  prove: async (req) => {
    if (req.circuitId !== "claim") {
      throw new Error(
        `claim.worker: refusing circuitId=${req.circuitId}; this worker only handles "claim"`,
      );
    }

    const input = req.input as unknown as ClaimProofInput;

    return withCachedAssets(CIRCUIT_ASSETS, async (urls) => {
      const result = await generateClaimProof(input, urls);
      return { proof: result.proof, publicSignals: result.publicSignals };
    });
  },
});
