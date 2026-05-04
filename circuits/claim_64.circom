pragma circom 2.0.0;

include "./claim_template.circom";

// ════════════════════════════════════════════════════════════════════
//  claim_64.circom — TIER_64 wrapper (claimsTreeDepth=6 → 64 leaves)
//
//  Build output: claim_64.wasm / claim_64_final.zkey /
//  ClaimVerifier_64.sol. Activated on-chain via
//  `setClaimVerifier(64, addr)`. Use this when the source settlement
//  was produced by `authorize_64.circom`.
// ════════════════════════════════════════════════════════════════════

component main {public [
    claimsRoot,
    nullifier,
    amount,
    token,
    recipient,
    releaseTime
]} = Claim(6);
