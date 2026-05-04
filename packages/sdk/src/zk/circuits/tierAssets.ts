import { type CircuitTier, TIER_16 } from "../constants";
import type { CircuitAssets } from "./deposit";

/** Asset URL pair for one circuit tier. Re-exports {@link CircuitAssets}
 *  under a tier-flavoured name for callsites that surface tiers
 *  explicitly; consumers can pass either type interchangeably. */
export type TierAssetPaths = CircuitAssets;

/** Resolve the per-tier authorize-circuit asset URLs for a given
 *  static-asset base directory.
 *
 *  - TIER_16 → `<baseDir>/authorize.wasm` + `<baseDir>/authorize_final.zkey`
 *    (legacy filename, present in every existing deploy).
 *  - Higher tiers → `<baseDir>/authorize_<cap>.wasm` +
 *    `<baseDir>/authorize_<cap>_final.zkey` (e.g. `authorize_64.wasm`).
 *
 *  Today only the TIER_16 artifacts exist in `circuits/build/`; the
 *  higher-tier paths will 404 until the corresponding ceremony ships
 *  the matching `.wasm` / `.zkey` files. Production paths can't reach
 *  those URLs accidentally — `pickActiveTier` only returns tiers in
 *  {@link ACTIVE_TIERS}, which the deploy controls. The intentional
 *  side effect: the moment a TIER_64 / TIER_128 ceremony drops the
 *  files alongside the tier-16 ones and updates `ACTIVE_TIERS`, every
 *  caller picks up the new artifacts with no code change.
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
