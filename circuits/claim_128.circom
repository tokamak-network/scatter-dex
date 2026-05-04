pragma circom 2.0.0;

include "./claim_template.circom";

// ════════════════════════════════════════════════════════════════════
//  claim_128.circom — TIER_128 wrapper (claimsTreeDepth=7 → 128 leaves)
//
//  Build output: claim_128.wasm / claim_128_final.zkey /
//  ClaimVerifier_128.sol. Activated on-chain via
//  `setClaimVerifier(128, addr)`. Use this when the source settlement
//  was produced by `authorize_128.circom`.
// ════════════════════════════════════════════════════════════════════

component main {public [
    claimsRoot,
    nullifier,
    amount,
    token,
    recipient,
    releaseTime
]} = Claim(7);
