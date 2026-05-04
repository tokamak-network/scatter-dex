pragma circom 2.0.0;

include "./authorize_template.circom";

// ════════════════════════════════════════════════════════════════════
//  authorize_64.circom — TIER_64 wrapper
//
//  Build output: authorize_64.wasm / authorize_64_final.zkey /
//  AuthorizeVerifier_64.sol. Activated on-chain via
//  `setAuthorizeVerifier(64, addr)` and in the SDK by adding TIER_64
//  to `ACTIVE_TIERS`.
//
//  Parameters:
//   - commitTreeDepth=20   (shared with all tiers)
//   - maxClaimsPerSide=64  (4× tier-16 capacity)
//   - claimsTreeDepth=6    (2^6 = 64 leaves)
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
]} = Authorize(20, 64, 6);
