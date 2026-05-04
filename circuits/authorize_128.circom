pragma circom 2.0.0;

include "./authorize_template.circom";

// ════════════════════════════════════════════════════════════════════
//  authorize_128.circom — TIER_128 wrapper
//
//  Build output: authorize_128.wasm / authorize_128_final.zkey /
//  AuthorizeVerifier_128.sol. Activated on-chain via
//  `setAuthorizeVerifier(128, addr)` and in the SDK by adding TIER_128
//  to `ACTIVE_TIERS`.
//
//  Parameters:
//   - commitTreeDepth=20    (shared with all tiers)
//   - maxClaimsPerSide=128  (8× tier-16 capacity — heaviest mobile-borderline)
//   - claimsTreeDepth=7     (2^7 = 128 leaves)
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
]} = Authorize(20, 128, 7);
