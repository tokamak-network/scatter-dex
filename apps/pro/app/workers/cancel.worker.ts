/// <reference lib="webworker" />
//
// Web Worker that runs the cancel-circuit prover off the main thread.
// Cancel proves the user owns the escrow being rotated and signs the
// nonce nullifier — circuit ≈ 8K constraints, ~1–2 s desktop /
// 5–9 s mobile.

import {
  generateCancelProof,
  setupProverWorker,
  warmProverAssets,
  warmupEddsa,
  withCachedAssets,
  timeProve,
  type CancelProofInput,
} from "@zkscatter/sdk/zk";

const CIRCUIT_ASSETS = {
  wasm: "/zk/cancel.wasm",
  zkey: "/zk/cancel_final.zkey",
} as const;

setupProverWorker({
  preload: async () => {
    await Promise.all([warmProverAssets(CIRCUIT_ASSETS), warmupEddsa()]);
  },

  prove: async (req) => {
    if (req.circuitId !== "cancel") {
      throw new Error(
        `cancel.worker: refusing circuitId=${req.circuitId}; this worker only handles "cancel"`,
      );
    }

    const input = req.input as unknown as CancelProofInput;

    return withCachedAssets(CIRCUIT_ASSETS, (urls) =>
      timeProve("cancel", async () => {
        const result = await generateCancelProof(input, urls);
        return { proof: result.proof, publicSignals: result.publicSignals };
      }),
    );
  },
});
