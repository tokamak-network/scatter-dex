pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/mux1.circom";
include "./tags.circom";

// Poseidon Merkle proof (same as in withdraw/settle)
template PoseidonMerkleProofClaim(levels) {
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

// Claim circuit: proves a claim leaf exists in a claimsRoot Merkle tree
template Claim(depth) {
    // ════════════════════════════════════════
    //  PUBLIC INPUTS
    // ════════════════════════════════════════
    signal input claimsRoot;        // root from settle (on-chain)
    signal input nullifier;         // prevents double-claim
    signal input amount;            // claim amount
    signal input token;             // token address
    signal input recipient;         // recipient address
    signal input releaseTime;       // when claimable

    // ════════════════════════════════════════
    //  PRIVATE INPUTS
    // ════════════════════════════════════════
    signal input secret;            // claim secret
    signal input leafIndex;         // position in claims tree
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // ════════════════════════════════════════
    //  1. COMPUTE CLAIM LEAF
    //     leaf = Poseidon(secret, recipient, token, amount, releaseTime)
    // ════════════════════════════════════════
    component leafHash = Poseidon(5);
    leafHash.inputs[0] <== secret;
    leafHash.inputs[1] <== recipient;
    leafHash.inputs[2] <== token;
    leafHash.inputs[3] <== amount;
    leafHash.inputs[4] <== releaseTime;

    // ════════════════════════════════════════
    //  2. MERKLE INCLUSION PROOF
    // ════════════════════════════════════════
    component merkle = PoseidonMerkleProofClaim(depth);
    merkle.leaf <== leafHash.out;
    for (var i = 0; i < depth; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }
    claimsRoot === merkle.root;

    // [PR #605 gemini SECURITY-CRITICAL] Bind leafIndex to pathIndices.
    // The nullifier below hashes `leafIndex` directly; the Merkle proof
    // above uses `pathIndices` independently. Without this constraint
    // a claimant could prove inclusion at position p (correct path bits
    // for p) while feeding a different `leafIndex` value into the
    // nullifier, producing as many distinct nullifiers as choices of
    // `leafIndex` for the same on-chain leaf — i.e. unbounded
    // re-claiming of the same payout. Reconstruct `leafIndex` as
    // sum_i pathIndices[i] * 2^i and require equality.
    //
    // `pathIndices[i]` is already constrained to `{0,1}` inside
    // `PoseidonMerkleProofClaim`, so the running sum cannot exceed
    // `2^depth - 1` and the reconstruction is exact.
    var leafIndexAcc = 0;
    var pow = 1;
    for (var i = 0; i < depth; i++) {
        leafIndexAcc += pathIndices[i] * pow;
        pow *= 2;
    }
    leafIndex === leafIndexAcc;

    // ════════════════════════════════════════
    //  3. NULLIFIER
    //  [M4] Domain-separated claim nullifier (tag 2). Tag value comes from
    //  the shared `tags.circom` helper so settle / withdraw / claim cannot
    //  drift from each other. Disjoints the claim nullifier space from
    //  the escrow (tag 0) and nonce (tag 1) nullifier spaces used by
    //  withdraw / settle.
    //     nullifier = Poseidon(2, secret, leafIndex, claimsRoot)
    //
    //  `claimsRoot` is bound into the preimage so the SAME (secret,
    //  leafIndex) in two DIFFERENT settled claims groups yields two
    //  DISTINCT nullifiers. Without it, a maker — who derives every
    //  recipient's claim secret — could settle a throwaway group with a
    //  colliding leaf, claim it, and permanently brick the honest
    //  recipient's claim in the real group (the on-chain claimNullifiers
    //  set is global). `claimsRoot` is already a bound public input.
    // ════════════════════════════════════════

    component nullComp = Poseidon(4);
    nullComp.inputs[0] <== TAG_CLAIM_NULL();
    nullComp.inputs[1] <== secret;
    nullComp.inputs[2] <== leafIndex;
    nullComp.inputs[3] <== claimsRoot;
    nullifier === nullComp.out;

    // ════════════════════════════════════════
    //  4. BIND PUBLIC INPUTS (prevent optimization)
    //
    //  [M6][C-2] `amount`, `recipient`, `token`, and `releaseTime` are
    //  public inputs bound to the proof at the verification-key level.
    //  The squaring statements below prevent the circom optimizer from
    //  dropping these signals from the witness — without at least
    //  one constraint that *uses* them, the compiler may consider them
    //  dead and elide them, leading to verification keys that no longer
    //  cover the public inputs.
    //
    //  The choice of `x * x` is the simplest constraint that touches
    //  every bit of the input without leaking any structural information.
    //  See: https://docs.circom.io/circom-language/signals/#unused-signals
    // ════════════════════════════════════════
    signal amountSq;
    amountSq <== amount * amount;
    signal recipientSq;
    recipientSq <== recipient * recipient;
    signal tokenSq;
    tokenSq <== token * token;
    signal releaseTimeSq;
    releaseTimeSq <== releaseTime * releaseTime;
}

// Template-only file — no `component main`. Per-tier wrapper files
// (`claim.circom`, `claim_64.circom`, `claim_128.circom`) instantiate
// `Claim(claimsTreeDepth)` with their tier's depth so each tier
// compiles into its own r1cs / wasm / zkey under `circuits/build/`.
// Depth must match the source authorize tier's claimsTreeDepth so
// the per-claim Merkle proof reconstructs the same `claimsRoot` the
// settlement was built against.
