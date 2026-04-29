/// <reference lib="webworker" />

import {
  authorizeMetaFrom,
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
      // Surface the named scalars via meta so the main thread can pack
      // SettleAuthSide without re-deriving by public-signal index.
      return {
        proof: result.proof,
        publicSignals: result.publicSignals,
        meta: authorizeMetaFrom(result),
      };
    });
  },
});
