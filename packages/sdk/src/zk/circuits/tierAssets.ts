import { type CircuitTier, TIER_16 } from "../constants";
import type { CircuitAssets } from "./deposit";

/** Asset URL pair for one circuit tier. Re-exports {@link CircuitAssets}
 *  under a tier-flavoured name for callsites that surface tiers
 *  explicitly; consumers can pass either type interchangeably. */
export type TierAssetPaths = CircuitAssets;

/** Resolve the per-tier authorize-circuit asset URLs for a given
 *  static-asset base directory.
 *
 *  Today only TIER_16 has compiled assets in `circuits/build/`; the
 *  TIER_64 / TIER_128 paths point at the same tier-16 files as a
 *  **placeholder** so consumer apps can already wire `pickActiveTier`
 *  through the worker layer without crashing on an unknown tier.
 *  When tier-64 / tier-128 ceremonies land, those entries flip to the
 *  real artifacts (`authorize_64.wasm` / `authorize_64_final.zkey`,
 *  etc.) and every caller picks them up automatically.
 *
 *  The placeholder mapping is intentionally NOT silent — the
 *  `ACTIVE_TIERS` gate in production paths (Pay's `pickActiveTier`)
 *  prevents callers from ever requesting a tier whose verifier isn't
 *  on-chain, so the placeholder can only be reached via tests or
 *  manual overrides.
 *
 *  Pass `baseDir` like `"/zk"` (Pay's `public/zk` static folder) or
 *  the per-app deploy path. No trailing slash. */
export function authorizeAssetPaths(
  tier: CircuitTier,
  baseDir: string,
): { wasm: string; zkey: string } {
  const stem = authorizeAssetStem(tier);
  return {
    wasm: `${baseDir}/${stem}.wasm`,
    zkey: `${baseDir}/${stem}_final.zkey`,
  };
}

/** Same idea as {@link authorizeAssetPaths} but for the claim circuit.
 *  Claim circuits are tier-specific because the claims tree depth
 *  matches the source settlement's tier — a tier-64 settlement hands
 *  out claim packages whose proofs need a depth-6 claim circuit. */
export function claimAssetPaths(
  tier: CircuitTier,
  baseDir: string,
): { wasm: string; zkey: string } {
  const stem = claimAssetStem(tier);
  return {
    wasm: `${baseDir}/${stem}.wasm`,
    zkey: `${baseDir}/${stem}_final.zkey`,
  };
}

function authorizeAssetStem(tier: CircuitTier): string {
  // TIER_16 keeps the legacy `authorize.wasm` filename so existing
  // public/zk deployments don't need a rename to stay working. New
  // tiers get `authorize_<cap>.wasm`.
  if (tier.cap === TIER_16.cap) return "authorize";
  return `authorize_${tier.cap}`;
}

function claimAssetStem(tier: CircuitTier): string {
  if (tier.cap === TIER_16.cap) return "claim";
  return `claim_${tier.cap}`;
}
