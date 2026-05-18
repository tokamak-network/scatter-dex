/// <reference lib="webworker" />
//
// Web Worker that runs the withdraw-circuit prover off the main
// thread. Mirrors `deposit.worker.ts` — the withdraw circuit is
// ~3k constraints so it's larger than deposit but still under
// 1–2 s desktop. Off-main keeps React responsive during the prove.

import {
  generateWithdrawProof,
  setupProverWorker,
  warmProverAssets,
  withCachedAssets,
  type WithdrawProofInput,
} from "@zkscatter/sdk/zk";

const CIRCUIT_ASSETS = {
  wasm: "/zk/withdraw.wasm",
  zkey: "/zk/withdraw_final.zkey",
} as const;

setupProverWorker({
  preload: async () => {
    await warmProverAssets(CIRCUIT_ASSETS);
  },

  prove: async (req) => {
    if (req.circuitId !== "withdraw") {
      throw new Error(
        `withdraw.worker: refusing circuitId=${req.circuitId}; this worker only handles "withdraw"`,
      );
    }
    // Caller passes a BigInt-backed `WithdrawProofInput` —
    // structured-clone preserves BigInts (note fields, amounts,
    // merkleProof path elements) end-to-end. The prover returns
    // the additional fields (root, nullifierHash, changeNote,
    // newCommitment, tokenHash) via the worker's `meta` channel
    // so the main thread can persist the change UTXO and pass
    // the integer signals straight into the on-chain call.
    const input = req.input as unknown as WithdrawProofInput;

    return withCachedAssets(CIRCUIT_ASSETS, async (urls) => {
      const result = await generateWithdrawProof(input, urls);
      // Pass through the discrete bigint signals the on-chain call
      // needs as separate fields (the contract takes them as
      // individual uint256 args, not packed in publicSignals). Partial-
      // withdraw change notes aren't supported yet — we only ship
      // full-amount withdraws, so newCommitment is always 0 and there's
      // no changeNote to persist on the main thread.
      return {
        proof: result.proof,
        publicSignals: result.publicSignals,
        meta: {
          root: result.root,
          nullifierHash: result.nullifierHash,
          newCommitment: result.newCommitment,
          tokenHash: result.tokenHash,
        },
      };
    });
  },
});
