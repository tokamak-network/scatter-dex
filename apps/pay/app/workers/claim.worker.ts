/// <reference lib="webworker" />

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
    // The package the recipient pasted in already carries the
    // pre-built merkle proof (siblings + bits) — pass it through to
    // skip the 16-leaf tree rebuild Pro's worker does. The SDK's
    // `merkleProof` fast path returns the same root the circuit
    // expects since pathElements + leaf were derived from the same
    // 16-leaf array on the operator side.
    const input = req.input as unknown as ClaimProofInput;
    return withCachedAssets(CIRCUIT_ASSETS, async (urls) => {
      const result = await generateClaimProof(input, urls);
      return {
        proof: result.proof,
        publicSignals: result.publicSignals,
        meta: { claimsRoot: result.claimsRoot, nullifier: result.nullifier },
      };
    });
  },
});
