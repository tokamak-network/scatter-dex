/// <reference lib="webworker" />
//
// Web Worker that runs the claim-circuit prover off the main thread.
// The claim circuit verifies a single recipient's slot inside a
// settled order's claims tree and burns the per-claim nullifier on
// release. Proves in ~1–2 s desktop / 5–9 s mobile.
//
// Two callers, two payload shapes:
//   1. **Operator self-claim** (`ClaimModal.tsx`): sends
//      `{ entry, leafIndex }`; the worker rebuilds the Poseidon
//      claims tree on-thread via `singleClaimTree` and uses TIER_16
//      (operator orders are always tier-16).
//   2. **Recipient claim** (`/claim` page via `lib/claimSubmit.ts`):
//      sends a flat `ClaimProofInput` with `merkleProof` already
//      derived from the claim package's `pathElements` /
//      `pathIndices`. Tier is detected from `pathElements.length` so
//      tier-16 / tier-64 / tier-128 packages all dispatch correctly.
// The branch is taken on the shape of `req.input`; the SDK helpers
// (`generateClaimProof`) accept the same `ClaimProofInput` from
// either path, so only the assembly differs.

import {
  TIER_16,
  TIER_64,
  TIER_128,
  generateClaimProof,
  setupProverWorker,
  singleClaimTree,
  warmProverAssets,
  withCachedAssets,
  type CircuitTier,
  type ClaimProofInput,
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

/** Operator self-claim input — the main thread sends the BigInt-backed
 *  entry + leafIndex only, the Poseidon tree construction runs here
 *  so circomlibjs's ~50–150 ms init never blocks the UI thread. */
interface OperatorClaimInput {
  entry: {
    secret: bigint;
    recipient: bigint;
    token: bigint;
    amount: bigint;
    releaseTime: bigint;
  };
  leafIndex: number;
}

function isOperatorClaimInput(input: unknown): input is OperatorClaimInput {
  return (
    typeof input === "object" &&
    input !== null &&
    "entry" in input &&
    typeof (input as { entry: unknown }).entry === "object"
  );
}

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

    let proofInput: ClaimProofInput;
    let bundle: { tier: CircuitTier; assets: { wasm: string; zkey: string } };
    if (isOperatorClaimInput(req.input)) {
      // Operator self-claim: rebuild the tier-16 tree on-thread, no
      // pre-derived merkle proof from the caller.
      const { entry, leafIndex } = req.input;
      const { allClaimLeaves } = await singleClaimTree(entry, leafIndex);
      proofInput = { ...entry, leafIndex, allClaimLeaves };
      bundle = TIER_ASSETS[TIER_16.claimsTreeDepth];
    } else {
      // Recipient claim: package carries `merkleProof` already; tier
      // is inferred from `pathElements.length` so tier-16 / tier-64 /
      // tier-128 packages dispatch without an out-of-band declaration.
      const input = req.input as unknown as ClaimProofInput;
      if (!input.merkleProof) {
        throw new Error(
          "claim.worker: input must carry either `entry` (operator self-claim) " +
            "or `merkleProof` (recipient claim from a shared link)",
        );
      }
      const depth = input.merkleProof.pathElements.length;
      const picked = TIER_ASSETS[depth];
      if (!picked) {
        throw new Error(
          `claim.worker: no claim circuit registered for tree depth ${depth}; ` +
            `expected one of ${Object.keys(TIER_ASSETS).join(", ")}`,
        );
      }
      proofInput = input;
      bundle = picked;
    }

    return withCachedAssets(bundle.assets, async (urls) => {
      const result = await generateClaimProof(proofInput, urls, bundle.tier);
      return {
        proof: result.proof,
        publicSignals: result.publicSignals,
        meta: { claimsRoot: result.claimsRoot, nullifier: result.nullifier },
      };
    });
  },
});
