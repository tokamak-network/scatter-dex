/// <reference lib="webworker" />

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

setupProverWorker({
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
      // Surface the named scalars `generateAuthorizeProof` already
      // extracted from publicSignals so the main thread can pack the
      // SettleAuthSide tuple without re-deriving by signal index.
      return {
        proof: result.proof,
        publicSignals: result.publicSignals,
        meta: {
          pubKeyBind: result.pubKeyBind,
          commitmentRoot: result.commitmentRoot,
          nullifier: result.nullifier,
          nonceNullifier: result.nonceNullifier,
          newCommitment: result.newCommitment,
          claimsRoot: result.claimsRoot,
          totalLocked: result.totalLocked,
          orderHash: result.orderHash,
        },
      };
    });
  },
});
