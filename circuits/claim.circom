pragma circom 2.0.0;

include "./claim_template.circom";

// ════════════════════════════════════════════════════════════════════
//  claim.circom — TIER_16 wrapper (claimsTreeDepth=4 → 16 leaves)
//
//  Build output: claim.wasm / claim_final.zkey / ClaimVerifier.sol —
//  legacy filenames so existing deploys don't need a rename. Higher
//  tiers live in `claim_64.circom` / `claim_128.circom`.
// ════════════════════════════════════════════════════════════════════

component main {public [
    claimsRoot,
    nullifier,
    amount,
    token,
    recipient,
    releaseTime
]} = Claim(4);
