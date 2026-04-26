/// <reference lib="webworker" />
//
// Web Worker that runs the authorize-circuit prover off the main
// thread. snarkjs.fullProve takes 1–2 s on desktop / 5–9 s on
// mobile and would freeze React if it ran inline.
//
// The worker speaks the SDK's prover protocol (ProverWorkerRequest /
// ProverWorkerResponse, defined in @zkscatter/sdk/zk). The main-
// thread client (createWebWorkerProver) handles single-flight
// queueing, AbortSignal-driven cancellation, and result decoding —
// this file only owns the per-job prove() call.

import {
  generateAuthorizeProof,
  setupProverWorker,
  warmupEddsa,
  warmupPoseidon,
  type AuthorizeProofInput,
} from "@zkscatter/sdk/zk";

setupProverWorker({
  // Build the Poseidon round-constant table and EdDSA / Babyjub
  // singletons before announcing readiness. Without this the very
  // first prove pays the ~50–150 ms × 3 build cost on the user's
  // hot path; with it the cost lands during worker boot and the
  // first prove gets the same latency as the second.
  preload: async () => {
    await Promise.all([warmupPoseidon(), warmupEddsa()]);
  },

  prove: async (req) => {
    // The main-thread caller (OrderModal → authorizeProver) packs
    // an `AuthorizeProofInput` into `req.input`. We trust the
    // shape on this side because the prover protocol already
    // validated the envelope (see workerRuntime.ts isProveRequest).
    const input = req.input as unknown as AuthorizeProofInput;

    const result = await generateAuthorizeProof(input, {
      wasm: "/zk/authorize.wasm",
      zkey: "/zk/authorize_final.zkey",
    });

    return {
      proof: result.proof,
      publicSignals: result.publicSignals,
    };
  },
});
