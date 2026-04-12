pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";
include "./tags.circom";

// ════════════════════════════════════════════════════════════════════
//  cancel.circom — Escrow rotation cancel (Candidate C)
//
//  Atomically cancels a pending authorize order by:
//    1. Burning the escrow nullifier (C1 dies permanently)
//    2. Burning the nonce nullifier (that specific order is dead)
//    3. Creating a new commitment with the same balance + new salt
//       (user can immediately make new orders with the rotated escrow)
//
//  The cancel proof is submitted on-chain via
//  PrivateSettlement.cancelPrivate(). No tokens move — the balance
//  stays in CommitmentPool, just under a new leaf.
//
//  Why this is needed:
//    - In the Half-proof model, the relayer holds the user's
//      authorize.circom proof and can call settleAuth at any time
//    - The relayer has no economic incentive to honor a soft cancel
//      (it loses fees)
//    - Only an on-chain nullifier burn provides trust-minimized cancel
//    - See: docs/circuit-split/cancel-design.md §6 (Candidate A+C)
//
//  Privacy:
//    - pubKeyAx/pubKeyAy are PRIVATE inputs (never exposed on-chain)
//    - Per ADR-001 D1: no per-trader-stable public output may be
//      exposed. The pubkey is bound into both old and new commitments
//      internally but never appears in the public signal set.
//
//  Circuit size: ~8K constraints (Merkle proof + 2×Poseidon-7 +
//    2×Poseidon-3 + EdDSA verify). Proof time: ~1-2s in browser.
//
//  Public outputs (5 signals):
//    [0] commitmentRoot   — current Merkle tree root
//    [1] oldNullifier     — escrow nullifier to burn
//    [2] oldNonceNullifier — nonce nullifier to burn
//    [3] newCommitment    — rotated escrow commitment (same balance)
//    [4] submitter        — msg.sender binding (the user, not a relayer)
// ════════════════════════════════════════════════════════════════════

// ── Poseidon Merkle membership proof (same as authorize.circom) ──
template CancelMerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    component mux[levels][2];
    signal hashes[levels + 1];
    hashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i][0] = Mux1();
        mux[i][0].c[0] <== hashes[i];
        mux[i][0].c[1] <== pathElements[i];
        mux[i][0].s <== pathIndices[i];

        mux[i][1] = Mux1();
        mux[i][1].c[0] <== pathElements[i];
        mux[i][1].c[1] <== hashes[i];
        mux[i][1].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i][0].out;
        hashers[i].inputs[1] <== mux[i][1].out;
        hashes[i + 1] <== hashers[i].out;
    }
    root <== hashes[levels];
}

// ════════════════════════════════════════════════════════════════════
template Cancel(commitTreeDepth) {
    // ── Public inputs ──
    signal input commitmentRoot;
    signal input oldNullifier;
    signal input oldNonceNullifier;
    signal input newCommitment;
    signal input submitter;

    // ── Private inputs ──
    signal input secret;
    signal input salt;
    signal input nonce;
    signal input token;
    signal input balance;
    signal input freshSalt;         // new salt for the rotated commitment
    signal input path[commitTreeDepth];
    signal input pathIdx[commitTreeDepth];

    // EdDSA signature over cancel message
    // [ADR-001 D1] pubkey is PRIVATE — never exposed as public output
    signal input pubKeyAx;
    signal input pubKeyAy;
    signal input sigS;
    signal input sigR8x;
    signal input sigR8y;

    // ════════════════════════════════════════
    //  1. OLD COMMITMENT MEMBERSHIP
    //     Proves the user owns a commitment in the tree.
    //     commitment = Poseidon(TAG_V2, secret, token, balance, salt, Ax, Ay)
    // ════════════════════════════════════════
    component oldCommitHash = Poseidon(7);
    oldCommitHash.inputs[0] <== TAG_COMMITMENT_V2();
    oldCommitHash.inputs[1] <== secret;
    oldCommitHash.inputs[2] <== token;
    oldCommitHash.inputs[3] <== balance;
    oldCommitHash.inputs[4] <== salt;
    oldCommitHash.inputs[5] <== pubKeyAx;
    oldCommitHash.inputs[6] <== pubKeyAy;

    component merkle = CancelMerkleProof(commitTreeDepth);
    merkle.leaf <== oldCommitHash.out;
    for (var i = 0; i < commitTreeDepth; i++) {
        merkle.pathElements[i] <== path[i];
        merkle.pathIndices[i] <== pathIdx[i];
    }
    commitmentRoot === merkle.root;

    // ════════════════════════════════════════
    //  2. ESCROW NULLIFIER
    //     oldNullifier = Poseidon(TAG_ESCROW_NULL, secret, salt)
    //     Same derivation as settle/authorize/withdraw.
    // ════════════════════════════════════════
    component escrowNull = Poseidon(3);
    escrowNull.inputs[0] <== TAG_ESCROW_NULL();
    escrowNull.inputs[1] <== secret;
    escrowNull.inputs[2] <== salt;
    oldNullifier === escrowNull.out;

    // ════════════════════════════════════════
    //  3. NONCE NULLIFIER
    //     oldNonceNullifier = Poseidon(TAG_NONCE_NULL, secret, nonce)
    //     Burns the specific order's nonce.
    // ════════════════════════════════════════
    component nonceNull = Poseidon(3);
    nonceNull.inputs[0] <== TAG_NONCE_NULL();
    nonceNull.inputs[1] <== secret;
    nonceNull.inputs[2] <== nonce;
    oldNonceNullifier === nonceNull.out;

    // ════════════════════════════════════════
    //  4. NEW COMMITMENT (escrow rotation)
    //     Same balance, same token, same secret, same pubkey.
    //     Only the salt changes → different leaf hash → fresh UTXO.
    //     newCommitment = Poseidon(TAG_V2, secret, token, balance, freshSalt, Ax, Ay)
    // ════════════════════════════════════════
    component newCommitHash = Poseidon(7);
    newCommitHash.inputs[0] <== TAG_COMMITMENT_V2();
    newCommitHash.inputs[1] <== secret;
    newCommitHash.inputs[2] <== token;
    newCommitHash.inputs[3] <== balance;
    newCommitHash.inputs[4] <== freshSalt;
    newCommitHash.inputs[5] <== pubKeyAx;
    newCommitHash.inputs[6] <== pubKeyAy;
    newCommitment === newCommitHash.out;

    // ════════════════════════════════════════
    //  4b. RANGE CHECK
    //      balance must fit in 128 bits (matches authorize.circom / settle.circom).
    // ════════════════════════════════════════
    component rcBalance = Num2Bits(128);
    rcBalance.in <== balance;

    // ════════════════════════════════════════
    //  5. EdDSA SIGNATURE VERIFICATION
    //     The cancel message is Poseidon(oldNonceNullifier, submitter).
    //     This proves:
    //       - The canceller holds the EdDSA key bound in the commitment
    //       - The cancel is intentional (signed over the specific nonce
    //         being cancelled + the submitter's Ethereum address)
    //     The message is distinct from orderHash (Poseidon-9) so an
    //     authorize signature cannot be replayed as a cancel signature.
    //     `submitter` binds msg.sender — prevents front-running the
    //     cancel tx by replaying the proof from a different address.
    // ════════════════════════════════════════
    component cancelMsg = Poseidon(2);
    cancelMsg.inputs[0] <== oldNonceNullifier;
    cancelMsg.inputs[1] <== submitter;

    component sigVerify = EdDSAPoseidonVerifier();
    sigVerify.enabled <== 1;
    sigVerify.Ax <== pubKeyAx;
    sigVerify.Ay <== pubKeyAy;
    sigVerify.S <== sigS;
    sigVerify.R8x <== sigR8x;
    sigVerify.R8y <== sigR8y;
    sigVerify.M <== cancelMsg.out;

    // ════════════════════════════════════════
    //  6. SUBMITTER BINDING
    //     Keeps `submitter` in the witness so the circom optimizer
    //     doesn't prune it. Same idiom as authorize.circom / settle.circom
    //     (where the field is called `relayer`). In cancel, the submitter
    //     is the user, not a relayer.
    // ════════════════════════════════════════
    signal submitterSq;
    submitterSq <== submitter * submitter;
}

// Parameters: commitTreeDepth=20 (matches settle/authorize/withdraw)
component main {public [
    commitmentRoot,
    oldNullifier,
    oldNonceNullifier,
    newCommitment,
    submitter
]} = Cancel(20);
