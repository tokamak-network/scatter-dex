pragma circom 2.0.0;

// ════════════════════════════════════════════════════════════════════
//  Shared Poseidon domain-separation tags.
//
//  Every Poseidon-based commitment, nullifier, or bound hash in this
//  codebase prepends one of these tags as the first input so the
//  preimage spaces are disjoint by construction. Keeping the constants
//  in one file removes the silent-drift hazard of duplicating them
//  across withdraw.circom / claim.circom / deposit.circom /
//  authorize.circom / cancel.circom.
//
//  WARNING: any change to these values is a *consensus break*. The
//  matching off-chain helpers must be updated in lock-step:
//    - zk-relayer/src/core/tags.ts
//    - frontend/app/lib/zk/tags.ts
//
//  These are circom `function`s (not `var`s) because functions are
//  inlined at compile time and produce zero constraints, while still
//  being importable from any template that needs them.
//
//  ── Tag assignments ──
//  0 : escrow nullifier      Poseidon(0, secret, salt)
//  1 : nonce nullifier       Poseidon(1, secret, nonce)
//  2 : claim nullifier       Poseidon(2, secret, leafIndex)
//  3 : commitment v2         Poseidon(3, secret, token, amount, salt, pubKeyAx, pubKeyAy)
//
//  [issue #128] TAG_COMMITMENT_V2 was added to bind the BabyJub signing
//  pubkey into the escrow commitment preimage, closing the "swap-the-key"
//  attack surfaced in the PR #127 Copilot review. The previous v1 format
//  Poseidon(secret, token, amount, salt) is a clean-cutover replacement —
//  no legacy verifier is kept.
// ════════════════════════════════════════════════════════════════════

function TAG_ESCROW_NULL()   { return 0; }
function TAG_NONCE_NULL()    { return 1; }
function TAG_CLAIM_NULL()    { return 2; }
function TAG_COMMITMENT_V2() { return 3; }
