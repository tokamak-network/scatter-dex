/// <reference lib="webworker" />
//
// Web Worker that runs the deposit-circuit prover off the main
// thread. The deposit circuit is the smallest of the five (~400
// constraints) — proves in well under 0.5 s on desktop and 1–2 s
// on mobile — but we still offload so the user's first deposit
// doesn't block React while snarkjs boots Poseidon tables.

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

// Timing telemetry runs on the main thread side — see the matching
// note in `authorize.worker.ts`. Workers can't dispatch the
// `zk-perf:prove` window event.

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

    // The main-thread caller (DepositModal → depositProver) packs
    // a `CommitmentNote` into `req.input` (it has no extra fields
    // — generateDepositProof derives the commitment internally).
    // Reconstruct the BigInt fields snarkjs needs.
    const note = req.input as unknown as CommitmentNote;

    return withCachedAssets(CIRCUIT_ASSETS, async (urls) => {
      const result = await generateDepositProof(note, urls);
      return { proof: result.proof, publicSignals: result.publicSignals };
    });
  },
});
