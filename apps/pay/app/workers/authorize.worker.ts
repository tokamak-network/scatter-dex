/// <reference lib="webworker" />

import {
  authorizeAssetPaths,
  authorizeMetaFrom,
  generateAuthorizeProof,
  setupProverWorker,
  TIER_16,
  TIERS,
  warmProverAssets,
  warmupEddsa,
  withCachedAssets,
  type AuthorizeProofInput,
  type CircuitTier,
} from "@zkscatter/sdk/zk";

// Static asset base for Pay's `public/zk` deployment. The per-tier
// asset filenames are resolved via `authorizeAssetPaths` so a future
// tier-64 / tier-128 ceremony only needs to drop new files alongside
// the tier-16 ones — no worker code change.
const ASSET_BASE = "/zk";

// Pre-warm only the active TIER_16 assets on worker boot. Future
// tiers warm lazily on first prove so we don't pay the bandwidth cost
// for tiers the operator may never invoke.
const TIER_16_ASSETS = authorizeAssetPaths(TIER_16, ASSET_BASE);

function resolveTier(hint: CircuitTier | undefined): CircuitTier {
  if (!hint) return TIER_16;
  // Look up by cap so structurally-cloned tiers re-canonicalize against
  // the SDK's `TIERS` table — guards against a malicious or malformed
  // hint with a cap the prover doesn't actually support.
  const known = TIERS.find((t) => t.cap === hint.cap);
  if (!known) {
    throw new Error(
      `authorize.worker: unknown tier cap=${hint.cap} — every active tier must be present in TIERS`,
    );
  }
  return known;
}

setupProverWorker({
  preload: async () => {
    await Promise.all([warmProverAssets(TIER_16_ASSETS), warmupEddsa()]);
  },

  prove: async (req) => {
    if (req.circuitId !== "authorize") {
      throw new Error(
        `authorize.worker: refusing circuitId=${req.circuitId}; this worker only handles "authorize"`,
      );
    }
    const tier = resolveTier(req.tier);
    const input = req.input as unknown as AuthorizeProofInput;
    const assets = authorizeAssetPaths(tier, ASSET_BASE);
    return withCachedAssets(assets, async (urls) => {
      const result = await generateAuthorizeProof(input, urls, tier);
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
