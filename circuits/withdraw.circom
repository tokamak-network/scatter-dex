pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";

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

    // ════════════════════════════════════════
    //  1. COMPUTE COMMITMENT
    // ════════════════════════════════════════
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== ownerSecret;
    commitmentHasher.inputs[1] <== token;
    commitmentHasher.inputs[2] <== amount;
    commitmentHasher.inputs[3] <== salt;

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
    // ════════════════════════════════════════
    component nullifierComp = Poseidon(2);
    nullifierComp.inputs[0] <== ownerSecret;
    nullifierComp.inputs[1] <== salt;
    nullifierHash === nullifierComp.out;

    // ════════════════════════════════════════
    //  4. VERIFY TOKEN BINDING
    // ════════════════════════════════════════
    component tokenHasher = Poseidon(1);
    tokenHasher.inputs[0] <== token;
    tokenHash === tokenHasher.out;

    // ════════════════════════════════════════
    //  5. BALANCE CHECK: withdrawAmount <= amount
    // ════════════════════════════════════════
    component leq = LessEqThan(252);
    leq.in[0] <== withdrawAmount;
    leq.in[1] <== amount;
    leq.out === 1;

    // ════════════════════════════════════════
    //  6. CHANGE COMMITMENT
    // ════════════════════════════════════════
    signal changeAmount;
    changeAmount <== amount - withdrawAmount;

    // Compute expected change commitment
    component changeHasher = Poseidon(4);
    changeHasher.inputs[0] <== ownerSecret;
    changeHasher.inputs[1] <== token;
    changeHasher.inputs[2] <== changeAmount;
    changeHasher.inputs[3] <== newSalt;

    // If changeAmount == 0, expected commitment is 0
    // If changeAmount > 0, expected commitment is the hash
    component isZeroChange = IsZero();
    isZeroChange.in <== changeAmount;

    signal expectedCommitment;
    expectedCommitment <== (1 - isZeroChange.out) * changeHasher.out;
    newCommitment === expectedCommitment;

    // ════════════════════════════════════════
    //  7. PREVENT RECIPIENT/RELAYER OPTIMIZATION
    //     (Bind to proof so it can't be front-run)
    // ════════════════════════════════════════
    signal recipientSq;
    recipientSq <== recipient * recipient;
    signal relayerSq;
    relayerSq <== relayer * relayer;
}

component main {public [root, nullifierHash, newCommitment, tokenHash, withdrawAmount, recipient, relayer]} = Withdraw(20);
