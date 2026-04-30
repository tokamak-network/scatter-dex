/// <reference lib="webworker" />
//
// Deposit-circuit prover off the main thread. Mirror of pro's
// deposit.worker.ts — same SDK helpers, same caching pattern, just
// scoped to Pay's `/zk/` asset path so the worker can fetch the
// wasm/zkey synced into `apps/pay/public/zk` by `sync-zk-assets.mjs`.

import {
  generateDepositProof,
  setupProverWorker,
  warmProverAssets,
  withCachedAssets,
  type CommitmentNote,
} from "@zkscatter/sdk/zk";

const CIRCUIT_ASSETS = {
  wasm: "/zk/deposit.wasm",
  zkey: "/zk/deposit_final.zkey",
} as const;

setupProverWorker({
  preload: async () => {
    await warmProverAssets(CIRCUIT_ASSETS);
  },

  prove: async (req) => {
    if (req.circuitId !== "deposit") {
      throw new Error(
        `deposit.worker: refusing circuitId=${req.circuitId}; this worker only handles "deposit"`,
      );
    }
    const note = req.input as unknown as CommitmentNote;
    return withCachedAssets(CIRCUIT_ASSETS, async (urls) => {
      const result = await generateDepositProof(note, urls);
      return { proof: result.proof, publicSignals: result.publicSignals };
    });
  },
});
