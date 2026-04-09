pragma circom 2.0.0;

// ════════════════════════════════════════════════════════════════════
//  Shared nullifier domain-separation tags.
//
//  Every Poseidon-based nullifier in this codebase prepends one of these
//  tags as the first input so the three preimage spaces (escrow, nonce,
//  claim) are disjoint by construction. Keeping the constants in one
//  file removes the silent-drift hazard of duplicating them across
//  settle.circom / withdraw.circom / claim.circom.
//
//  WARNING: any change to these values is a *consensus break*. The
//  matching off-chain helpers must be updated in lock-step:
//    - zk-relayer/src/core/tags.ts
//    - frontend/app/lib/zk/tags.ts
//
//  These are circom `function`s (not `var`s) because functions are
//  inlined at compile time and produce zero constraints, while still
//  being importable from any template that needs them.
// ════════════════════════════════════════════════════════════════════

function TAG_ESCROW_NULL() { return 0; }
function TAG_NONCE_NULL()  { return 1; }
function TAG_CLAIM_NULL()  { return 2; }
