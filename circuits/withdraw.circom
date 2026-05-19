pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";
include "./tags.circom";

// Poseidon-based Merkle proof verification
template PoseidonMerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels]; // 0 = left, 1 = right

    signal output root;

    component hashers[levels];
    component mux[levels][2];

    signal hashes[levels + 1];
    hashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // pathIndices[i] must be 0 or 1
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // Select left/right inputs based on pathIndices
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

// Main withdraw circuit
// Proves: I know a commitment in the tree, I can withdraw some amount,
//         and create a change commitment for the remainder.
template Withdraw(levels) {
    // ════════════════════════════════════════
    //  PUBLIC INPUTS
    // ════════════════════════════════════════
    signal input root;              // Merkle tree root
    signal input nullifierHash;     // Poseidon(ownerSecret, salt) — prevents double-spend
    signal input newCommitment;     // change commitment (0 if full withdrawal)
    signal input tokenHash;         // Poseidon(token) — binds proof to specific token
    signal input withdrawAmount;    // amount being withdrawn
    signal input recipient;         // prevents front-running
    signal input relayer;           // relayer address (0 if self-withdraw)

    // ════════════════════════════════════════
    //  PRIVATE INPUTS
    // ════════════════════════════════════════
    signal input ownerSecret;
    signal input token;
    signal input amount;            // full balance in commitment
    signal input salt;
    signal input newSalt;           // salt for change commitment
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // [issue #128] BabyJub signing pubkey is part of the commitment
    // preimage. deposit.circom already validated curve membership and
    // rejected the identity point, so we can treat these as well-formed
    // here without paying the BabyCheck cost again.
    signal input pubKeyAx;
    signal input pubKeyAy;

    // EdDSA signature over the withdraw message (see §7 below).
    // Together with the commitment-bound `pubKeyAx/Ay` above, this
    // gates withdraw on possession of the wallet's EdDSA private key
    // — copying the note file alone is no longer sufficient to drain
    // the funds; an attacker also has to be able to produce a valid
    // BabyJub signature, which requires the original wallet's
    // ECDSA-signing capability (the EdDSA key is `keccak256` of a
    // wallet signature; see `deriveEdDSAKey` in the SDK).
    signal input sigS;
    signal input sigR8x;
    signal input sigR8y;

    // ════════════════════════════════════════
    //  1. COMPUTE COMMITMENT  (v2 — binds pubkey, see issue #128)
    // ════════════════════════════════════════
    component commitmentHasher = Poseidon(7);
    commitmentHasher.inputs[0] <== TAG_COMMITMENT_V2();
    commitmentHasher.inputs[1] <== ownerSecret;
    commitmentHasher.inputs[2] <== token;
    commitmentHasher.inputs[3] <== amount;
    commitmentHasher.inputs[4] <== salt;
    commitmentHasher.inputs[5] <== pubKeyAx;
    commitmentHasher.inputs[6] <== pubKeyAy;

    // ════════════════════════════════════════
    //  2. VERIFY MERKLE INCLUSION
    // ════════════════════════════════════════
    component merkleProof = PoseidonMerkleProof(levels);
    merkleProof.leaf <== commitmentHasher.out;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    root === merkleProof.root;

    // ════════════════════════════════════════
    //  3. VERIFY NULLIFIER
    //  [M4] Domain-separated escrow nullifier (tag 0). Tag value comes from
    //  the shared `tags.circom` helper so settle / withdraw / claim cannot
    //  drift from each other.
    // ════════════════════════════════════════

    component nullifierComp = Poseidon(3);
    nullifierComp.inputs[0] <== TAG_ESCROW_NULL();
    nullifierComp.inputs[1] <== ownerSecret;
    nullifierComp.inputs[2] <== salt;
    nullifierHash === nullifierComp.out;

    // ════════════════════════════════════════
    //  4. VERIFY TOKEN BINDING
    // ════════════════════════════════════════
    component tokenHasher = Poseidon(1);
    tokenHasher.inputs[0] <== token;
    tokenHash === tokenHasher.out;

    // ════════════════════════════════════════
    //  5. RANGE CHECKS + BALANCE CHECK
    //  [H2] Proves: amount ≤ 2^128−1 AND withdrawAmount ≤ amount.
    //  The difference underflows to a huge field element if
    //  withdrawAmount > amount, failing the Num2Bits(128) check.
    // ════════════════════════════════════════
    component rcAmount = Num2Bits(128);
    rcAmount.in <== amount;
    component rcDiff = Num2Bits(128);
    rcDiff.in <== amount - withdrawAmount;

    // ════════════════════════════════════════
    //  6. CHANGE COMMITMENT
    // ════════════════════════════════════════
    signal changeAmount;
    changeAmount <== amount - withdrawAmount;

    // Compute expected change commitment (v2 — binds the same pubkey)
    component changeHasher = Poseidon(7);
    changeHasher.inputs[0] <== TAG_COMMITMENT_V2();
    changeHasher.inputs[1] <== ownerSecret;
    changeHasher.inputs[2] <== token;
    changeHasher.inputs[3] <== changeAmount;
    changeHasher.inputs[4] <== newSalt;
    changeHasher.inputs[5] <== pubKeyAx;
    changeHasher.inputs[6] <== pubKeyAy;

    // If changeAmount == 0, expected commitment is 0
    // If changeAmount > 0, expected commitment is the hash
    component isZeroChange = IsZero();
    isZeroChange.in <== changeAmount;

    signal expectedCommitment;
    expectedCommitment <== (1 - isZeroChange.out) * changeHasher.out;
    newCommitment === expectedCommitment;

    // ════════════════════════════════════════
    //  7. EdDSA SIGNATURE VERIFICATION
    //     The withdraw message is Poseidon(nullifierHash, recipient).
    //     This proves:
    //       - The withdrawer holds the EdDSA key bound in the commitment
    //         (via `pubKeyAx/Ay`, which are committed-to in §1's
    //         commitment hash).
    //       - The withdraw destination is intentional: a leaked proof
    //         can't be replayed by another wallet to redirect funds —
    //         the signature commits to (nullifier, recipient), and
    //         flipping recipient would require a fresh signature
    //         (= a fresh EdDSA key in the right pubkey lineage).
    //
    //     This is the core gate that distinguishes the "note file is
    //     a bearer instrument" model (pre-#778, no gate) from the
    //     "withdraw requires the original wallet's signing key" model
    //     (this PR). The note file alone — `ownerSecret`, `salt`,
    //     `pubKeyAx/Ay` — is no longer enough; an attacker who copies
    //     it still cannot sign with the matching EdDSA private key
    //     because that key is derived from the wallet's own ECDSA
    //     signing capability via `deriveEdDSAKey` and never leaves
    //     the wallet's signing context.
    //
    //     The message tag (Poseidon-2 over (nullifier, recipient)) is
    //     distinct from authorize/cancel/settle's signed payloads so
    //     a signature from one circuit cannot be replayed to another.
    // ════════════════════════════════════════
    component withdrawMsg = Poseidon(2);
    withdrawMsg.inputs[0] <== nullifierHash;
    withdrawMsg.inputs[1] <== recipient;

    component sigVerify = EdDSAPoseidonVerifier();
    sigVerify.enabled <== 1;
    sigVerify.Ax <== pubKeyAx;
    sigVerify.Ay <== pubKeyAy;
    sigVerify.S <== sigS;
    sigVerify.R8x <== sigR8x;
    sigVerify.R8y <== sigR8y;
    sigVerify.M <== withdrawMsg.out;

    // ════════════════════════════════════════
    //  8. RELAYER BINDING
    //
    //  `recipient` is already constrained inside §7 — it feeds the
    //  EdDSA message Poseidon as `withdrawMsg.inputs[1]`, so it
    //  participates in real arithmetic constraints and the
    //  optimizer can't drop it. `relayer` is still a public input
    //  but doesn't participate in any constraint inside the EdDSA
    //  path, so keep the squaring idiom used by authorize.circom /
    //  settle.circom to defend against a future optimizer change
    //  that would treat unused public signals as dead.
    // ════════════════════════════════════════
    signal relayerSq;
    relayerSq <== relayer * relayer;
}

component main {public [root, nullifierHash, newCommitment, tokenHash, withdrawAmount, recipient, relayer]} = Withdraw(20);
