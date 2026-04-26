/// <reference lib="webworker" />
//
// Web Worker that runs the claim-circuit prover off the main thread.
// The claim circuit verifies a single recipient's slot inside a
// settled order's claims tree and burns the per-claim nullifier on
// release. Proves in ~1–2 s desktop / 5–9 s mobile.

import {
  generateClaimProof,
  setupProverWorker,
  singleClaimTree,
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

/** Worker input for the single-claim-tree path. The main thread
 *  sends the BigInt-backed `entry` + `leafIndex` only; the
 *  Poseidon-based tree construction runs here so circomlibjs's
 *  ~50–150 ms init never blocks the UI thread. When real settled
 *  orders arrive from chain events, callers can switch to sending
 *  a pre-derived `merkleProof` instead. */
interface ClaimWorkerInput {
  entry: {
    secret: bigint;
    recipient: bigint;
    token: bigint;
    amount: bigint;
    releaseTime: bigint;
  };
  leafIndex: number;
}

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

    const { entry, leafIndex } = req.input as unknown as ClaimWorkerInput;
    const { allClaimLeaves } = await singleClaimTree(entry, leafIndex);
    const proofInput: ClaimProofInput = {
      ...entry,
      leafIndex,
      allClaimLeaves,
    };

    return withCachedAssets(CIRCUIT_ASSETS, async (urls) => {
      const result = await generateClaimProof(proofInput, urls);
      return { proof: result.proof, publicSignals: result.publicSignals };
    });
  },
});
