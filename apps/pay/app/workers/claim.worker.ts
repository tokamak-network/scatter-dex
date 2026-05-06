/// <reference lib="webworker" />

import {
  TIER_16,
  TIER_64,
  TIER_128,
  generateClaimProof,
  setupProverWorker,
  warmProverAssets,
  withCachedAssets,
  type ClaimProofInput,
  type CircuitTier,
} from "@zkscatter/sdk/zk";

// One asset bundle + tier per active circuit. The worker picks the
// right one at prove-time by matching the package's
// `pathElements.length` to `tier.claimsTreeDepth`. Preload only the
// smallest tier so a clean session doesn't burn ~100 MB on assets a
// recipient may never use; the larger tiers fetch on first claim.
const TIER_ASSETS = {
  [TIER_16.claimsTreeDepth]: {
    tier: TIER_16,
    assets: { wasm: "/zk/claim.wasm", zkey: "/zk/claim_final.zkey" },
  },
  [TIER_64.claimsTreeDepth]: {
    tier: TIER_64,
    assets: { wasm: "/zk/claim_64.wasm", zkey: "/zk/claim_64_final.zkey" },
  },
  [TIER_128.claimsTreeDepth]: {
    tier: TIER_128,
    assets: { wasm: "/zk/claim_128.wasm", zkey: "/zk/claim_128_final.zkey" },
  },
} satisfies Record<number, { tier: CircuitTier; assets: { wasm: string; zkey: string } }>;

setupProverWorker({
  preload: async () => {
    await warmProverAssets(TIER_ASSETS[TIER_16.claimsTreeDepth].assets);
  },

  prove: async (req) => {
    if (req.circuitId !== "claim") {
      throw new Error(
        `claim.worker: refusing circuitId=${req.circuitId}; this worker only handles "claim"`,
      );
    }
    // The package the recipient pasted in already carries the
    // pre-built merkle proof (siblings + bits) — pass it through to
    // skip the tree rebuild Pro's worker does. Tier is detected
    // from `pathElements.length` so the same worker handles
    // tier-16 / tier-64 / tier-128 packages without the operator
    // having to declare the circuit out-of-band.
    const input = req.input as unknown as ClaimProofInput;
    if (!input.merkleProof) {
      throw new Error(
        "claim.worker: input.merkleProof is required (Pay packages always carry it)",
      );
    }
    const depth = input.merkleProof.pathElements.length;
    const bundle = TIER_ASSETS[depth];
    if (!bundle) {
      throw new Error(
        `claim.worker: no claim circuit registered for tree depth ${depth}; expected one of ${Object.keys(TIER_ASSETS).join(", ")}`,
      );
    }
    return withCachedAssets(bundle.assets, async (urls) => {
      const result = await generateClaimProof(input, urls, bundle.tier);
      return {
        proof: result.proof,
        publicSignals: result.publicSignals,
        meta: { claimsRoot: result.claimsRoot, nullifier: result.nullifier },
      };
    });
  },
});
