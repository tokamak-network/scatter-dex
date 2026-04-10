pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./tags.circom";

// ════════════════════════════════════════════════════════════════════
//  cancel.circom — Off-chain order cancellation primitive
//
//  In the Half-proof model (authorize.circom), a user's proof is a
//  valid Groth16 artifact that any relayer can submit on-chain. To
//  cancel a pending order before it gets matched, the user needs to
//  prove ownership of the order without revealing their EdDSA public
//  key (which is private per ADR-001 D1 — no per-trader-stable public
//  output may be exposed).
//
//  cancel.circom proves:
//    "I am the signer of the order with hash `orderHash`, and the
//     nonce nullifier for that order is `nonceNullifier`."
//
//  The relayer verifies this proof off-chain and marks the nonce
//  nullifier as cancelled in its orderbook. Any future match attempt
//  against an order with that nonce nullifier is rejected locally
//  (and the gossip layer propagates the cancel to other relayers).
//
//  On-chain finality: this cancel is relayer-level, not on-chain.
//  For absolute finality the user can withdraw their commitment
//  (consuming the escrow nullifier), which makes the authorize proof
//  permanently unexecutable. The cancel circuit is a lighter-weight
//  alternative that doesn't require gas.
//
//  Circuit size: ~5K constraints (1 Poseidon + 1 EdDSA verify).
//  Proof generation: ~0.5-1s in browser.
//
//  Public outputs (3 signals):
//    [0] nonceNullifier  — which nonce nullifier to mark as cancelled
//    [1] orderHash       — which order is being cancelled
//    [2] relayer          — the relayer this cancel is directed to
//
//  Private inputs:
//    - secret      — the user's escrow secret (proves nonce ownership)
//    - nonce       — the order's nonce (bound in orderHash)
//    - pubKeyAx/Ay — the EdDSA signing key (proves order authorship)
//    - sigS/R8x/R8y — EdDSA signature over orderHash
//
//  The cancel proof is NOT submitted on-chain — it is verified by the
//  relayer using a local CancelVerifier. If the relayer is malicious
//  and ignores the cancel, the user can fall back to an on-chain
//  withdrawal that consumes the escrow nullifier.
// ════════════════════════════════════════════════════════════════════

template Cancel() {
    // ── Public inputs ──
    signal input nonceNullifier;  // nonce nullifier to cancel
    signal input orderHash;       // order being cancelled
    signal input relayer;         // relayer this cancel is directed to

    // ── Private inputs ──
    signal input secret;          // escrow secret (for nonce nullifier derivation)
    signal input nonce;           // order nonce

    // EdDSA signature over orderHash
    signal input pubKeyAx;
    signal input pubKeyAy;
    signal input sigS;
    signal input sigR8x;
    signal input sigR8y;

    // ════════════════════════════════════════
    //  1. NONCE NULLIFIER DERIVATION
    //     nonceNullifier = Poseidon(TAG_NONCE_NULL, secret, nonce)
    //     Proves the canceller knows the secret + nonce that produce
    //     this nonce nullifier — same tag as settle/authorize.
    // ════════════════════════════════════════
    component nullComp = Poseidon(3);
    nullComp.inputs[0] <== TAG_NONCE_NULL();
    nullComp.inputs[1] <== secret;
    nullComp.inputs[2] <== nonce;
    nonceNullifier === nullComp.out;

    // ════════════════════════════════════════
    //  2. EdDSA SIGNATURE VERIFICATION
    //     Proves the canceller has the EdDSA private key that signed
    //     the original order (the same key used in authorize.circom §8).
    //     This closes the "anyone can cancel" attack: without the
    //     private key, the signature check fails.
    // ════════════════════════════════════════
    component sigVerify = EdDSAPoseidonVerifier();
    sigVerify.enabled <== 1;
    sigVerify.Ax <== pubKeyAx;
    sigVerify.Ay <== pubKeyAy;
    sigVerify.S <== sigS;
    sigVerify.R8x <== sigR8x;
    sigVerify.R8y <== sigR8y;
    sigVerify.M <== orderHash;

    // ════════════════════════════════════════
    //  3. RELAYER BINDING
    //     Same idiom as authorize.circom §9 — keep `relayer` in the
    //     witness so the circom optimizer doesn't prune it.
    // ════════════════════════════════════════
    signal relayerSq;
    relayerSq <== relayer * relayer;
}

component main {public [
    nonceNullifier,
    orderHash,
    relayer
]} = Cancel();
