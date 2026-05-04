pragma circom 2.0.0;

include "./authorize_template.circom";

// ════════════════════════════════════════════════════════════════════
//  authorize.circom — TIER_16 wrapper
//
//  Tier 16 is the legacy / default authorize circuit. The build script
//  emits this as `authorize.wasm` / `authorize_final.zkey` /
//  `AuthorizeVerifier.sol` so existing deploys keep working without a
//  rename. Higher tiers live in `authorize_64.circom` /
//  `authorize_128.circom` and produce `authorize_64.wasm` etc.
//
//  Parameters:
//   - commitTreeDepth=20   (1M commitments — shared across tiers)
//   - maxClaimsPerSide=16  (padded to power of 2)
//   - claimsTreeDepth=4    (2^4 = 16 leaves)
// ════════════════════════════════════════════════════════════════════

component main {public [
    commitmentRoot,
    nullifier,
    nonceNullifier,
    newCommitment,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    maxFee,
    expiry,
    claimsRoot,
    totalLocked,
    relayer,
    orderHash
]} = Authorize(20, 16, 4);
