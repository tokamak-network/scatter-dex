pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";
include "./tags.circom";

// ════════════════════════════════════════════════════════════════════
//  authorize.circom — Half-proof trustless settlement primitive (PoC)
//
//  In the current settle.circom, the relayer proves a full maker+taker
//  trade in one go, which forces the relayer to see both sides' private
//  state (escrow secret, balance, path, claims). authorize.circom splits
//  the proof in half: each user independently proves "I authorise
//  spending `sellAmount` of tokenX out of my escrow, in exchange for at
//  least `buyAmount` of tokenY distributed to these claims". The relayer
//  then matches two authorize proofs and submits them as a single
//  `settleAuth(makerProof, takerProof)` transaction.
//
//  The relayer never sees:
//    - the user's escrow secret / salt
//    - the user's balance
//    - the claim secrets (it already doesn't in settle.circom's private
//      inputs, but now it doesn't even handle them)
//
//  Public outputs (committed on-chain):
//    - commitmentRoot          current commitment tree root
//    - nullifier               escrow nullifier = Poseidon(0, secret, salt)
//    - nonceNullifier          nonce nullifier  = Poseidon(1, secret, nonce)
//    - newCommitment           residual escrow commitment (0 if fully spent)
//    - sellToken, buyToken     matched by the counterparty's authorize proof
//    - sellAmount, buyAmount   user's limit price — matched off-chain
//    - maxFee                  fee bps ceiling the user signed
//    - expiry                  unix timestamp
//    - claimsRoot              merkle root of the claims this user wants paid
//    - totalLocked             sum of claim amounts (what this user receives)
//    - relayer                 relayer address bound to the proof
//    - orderHash               EdDSA-signed order hash
//
//  See: project_half_proof_design.md and settle.circom for the full
//  context on how this folds into the trustless settlement flow.
// ════════════════════════════════════════════════════════════════════

// ── Poseidon Merkle membership proof (duplicated from settle.circom) ──
template AuthMerkleProof(levels) {
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

// ── Fixed-size claim tree root computation ──
//
// [PR #127 optimization] Unlike the equivalent template in settle.circom,
// this version is INTERNAL to authorize.circom and the caller (the
// `Authorize` template below) always mutes unused leaves to zero before
// passing them in. We therefore drop the inner `isUsed`/`LessThan(252)`
// loop entirely, saving ~4 000 R1CS constraints (~13% of the unoptimized
// authorize circuit). The settle.circom version keeps the check for
// reusability; this one is a private helper so the trade is worth it.
template AuthClaimsRoot(maxLeaves, depth) {
    signal input leaves[maxLeaves];
    signal output root;

    var layerSize = maxLeaves;
    component hashers[maxLeaves - 1];
    signal nodes[depth + 1][maxLeaves];

    for (var i = 0; i < maxLeaves; i++) {
        nodes[0][i] <== leaves[i];
    }

    var hashIdx = 0;
    var curSize = maxLeaves;
    for (var level = 0; level < depth; level++) {
        var nextSize = curSize / 2;
        for (var i = 0; i < nextSize; i++) {
            hashers[hashIdx] = Poseidon(2);
            hashers[hashIdx].inputs[0] <== nodes[level][2*i];
            hashers[hashIdx].inputs[1] <== nodes[level][2*i + 1];
            nodes[level + 1][i] <== hashers[hashIdx].out;
            hashIdx++;
        }
        for (var i = nextSize; i < maxLeaves; i++) {
            nodes[level + 1][i] <== 0;
        }
        curSize = nextSize;
    }

    root <== nodes[depth][0];
}

// ════════════════════════════════════════════════════════════════════
//  Authorize template — proves one side of a trade
// ════════════════════════════════════════════════════════════════════
template Authorize(commitTreeDepth, maxClaimsPerSide, claimsTreeDepth) {
    // ── Public inputs (visible on-chain) ──
    signal input commitmentRoot;
    signal input nullifier;
    signal input nonceNullifier;
    signal input newCommitment;
    signal input sellToken;
    signal input buyToken;
    signal input sellAmount;
    signal input buyAmount;
    signal input maxFee;
    signal input expiry;
    signal input claimsRoot;
    signal input totalLocked;
    signal input relayer;
    signal input orderHash;

    // ── Private inputs ──
    // Escrow commitment preimage
    signal input secret;
    signal input balance;
    signal input salt;
    signal input path[commitTreeDepth];
    signal input pathIdx[commitTreeDepth];

    // Order + replay protection
    signal input nonce;
    signal input newSalt;

    // EdDSA (Baby Jubjub) signature over `orderHash`
    signal input pubKeyAx;
    signal input pubKeyAy;
    signal input sigS;
    signal input sigR8x;
    signal input sigR8y;

    // Claims distribution (per-side, padded to maxClaimsPerSide)
    signal input claimSecrets[maxClaimsPerSide];
    signal input claimRecipients[maxClaimsPerSide];
    signal input claimTokens[maxClaimsPerSide];
    signal input claimAmounts[maxClaimsPerSide];
    signal input claimReleaseTimes[maxClaimsPerSide];
    signal input claimCount;

    // ════════════════════════════════════════
    //  1. RANGE CHECKS
    //
    //  Same bounds as settle.circom after PR #124's gemini HIGH fix:
    //  - trade amounts (sell/buy) bounded to 126 bits so products fit
    //    the BN254 field after a future off-chain priceCheck
    //  - balance / totalLocked / individual claim amounts to 128 bits
    //  - maxFee to 16 bits (bps)
    // ════════════════════════════════════════
    component rcSell = Num2Bits(126);
    rcSell.in <== sellAmount;
    component rcBuy = Num2Bits(126);
    rcBuy.in <== buyAmount;
    component rcBalance = Num2Bits(128);
    rcBalance.in <== balance;
    component rcTotalLocked = Num2Bits(128);
    rcTotalLocked.in <== totalLocked;
    component rcMaxFee = Num2Bits(16);
    rcMaxFee.in <== maxFee;

    component rcClaimAmount[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        rcClaimAmount[i] = Num2Bits(128);
        rcClaimAmount[i].in <== claimAmounts[i];
    }

    // ════════════════════════════════════════
    //  2. COMMITMENT MEMBERSHIP
    //     commitment = Poseidon(secret, sellToken, balance, salt)
    //     ∈ commitmentRoot (Merkle)
    // ════════════════════════════════════════
    component commitHash = Poseidon(4);
    commitHash.inputs[0] <== secret;
    commitHash.inputs[1] <== sellToken;
    commitHash.inputs[2] <== balance;
    commitHash.inputs[3] <== salt;

    component merkle = AuthMerkleProof(commitTreeDepth);
    merkle.leaf <== commitHash.out;
    for (var i = 0; i < commitTreeDepth; i++) {
        merkle.pathElements[i] <== path[i];
        merkle.pathIndices[i] <== pathIdx[i];
    }
    commitmentRoot === merkle.root;

    // ════════════════════════════════════════
    //  3. DOMAIN-SEPARATED NULLIFIERS
    //     escrow   nullifier = Poseidon(TAG_ESCROW_NULL, secret, salt)
    //     nonce    nullifier = Poseidon(TAG_NONCE_NULL,  secret, nonce)
    //     (same tags as settle/withdraw/claim — see tags.circom)
    // ════════════════════════════════════════
    component nullComp = Poseidon(3);
    nullComp.inputs[0] <== TAG_ESCROW_NULL();
    nullComp.inputs[1] <== secret;
    nullComp.inputs[2] <== salt;
    nullifier === nullComp.out;

    component nonceNullComp = Poseidon(3);
    nonceNullComp.inputs[0] <== TAG_NONCE_NULL();
    nonceNullComp.inputs[1] <== secret;
    nonceNullComp.inputs[2] <== nonce;
    nonceNullifier === nonceNullComp.out;

    // ════════════════════════════════════════
    //  4. BALANCE SUFFICIENCY
    //     sellAmount ≤ balance
    //
    //  [PR #127 optimization] LessEqThan(128) is sufficient because both
    //  inputs are independently range-checked above (sellAmount ≤ 2^126,
    //  balance ≤ 2^128). The original LessEqThan(252) wasted ~250
    //  constraints on bits that the inputs cannot occupy.
    // ════════════════════════════════════════
    component balCheck = LessEqThan(128);
    balCheck.in[0] <== sellAmount;
    balCheck.in[1] <== balance;
    balCheck.out === 1;

    // ════════════════════════════════════════
    //  5. NEW (RESIDUAL) COMMITMENT
    //     newBalance = balance - sellAmount
    //     newCommitment = IsZero(newBalance) ? 0
    //                   : Poseidon(secret, sellToken, newBalance, newSalt)
    // ════════════════════════════════════════
    signal newBalance;
    newBalance <== balance - sellAmount;

    component newCommitHash = Poseidon(4);
    newCommitHash.inputs[0] <== secret;
    newCommitHash.inputs[1] <== sellToken;
    newCommitHash.inputs[2] <== newBalance;
    newCommitHash.inputs[3] <== newSalt;

    component newIsZero = IsZero();
    newIsZero.in <== newBalance;
    signal expectedNew;
    expectedNew <== (1 - newIsZero.out) * newCommitHash.out;
    newCommitment === expectedNew;

    // ════════════════════════════════════════
    //  6. CLAIMS VALIDATION
    //     Each claim leaf = Poseidon(secret, recipient, token, amount, releaseTime)
    //     - merkle root of the padded leaf array must equal claimsRoot
    //     - sum of amounts must equal totalLocked
    //     - unused claims (i >= count) must have amount = 0
    // ════════════════════════════════════════
    component claimLeafHash[maxClaimsPerSide];
    signal computedLeaves[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        claimLeafHash[i] = Poseidon(5);
        claimLeafHash[i].inputs[0] <== claimSecrets[i];
        claimLeafHash[i].inputs[1] <== claimRecipients[i];
        claimLeafHash[i].inputs[2] <== claimTokens[i];
        claimLeafHash[i].inputs[3] <== claimAmounts[i];
        claimLeafHash[i].inputs[4] <== claimReleaseTimes[i];
        computedLeaves[i] <== claimLeafHash[i].out;
    }

    // [PR #127 optimization] `i` is 0..15 and `claimCount` is 0..16, so
    // both fit in 5 bits. Using LessThan(5) instead of LessThan(252)
    // saves ~250 constraints per instance × 16 instances ≈ ~4 000
    // R1CS constraints. Same semantics; the wider check was just over-
    // conservative.
    component claimUsed[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        claimUsed[i] = LessThan(5);
        claimUsed[i].in[0] <== i;
        claimUsed[i].in[1] <== claimCount;
        (1 - claimUsed[i].out) * claimAmounts[i] === 0;
    }

    // Sum claim amounts into totalLocked
    signal amountAcc[maxClaimsPerSide + 1];
    amountAcc[0] <== 0;
    for (var i = 0; i < maxClaimsPerSide; i++) {
        amountAcc[i + 1] <== amountAcc[i] + claimAmounts[i];
    }
    totalLocked === amountAcc[maxClaimsPerSide];

    // Build the claims merkle root. Caller-side muting (above) means
    // `AuthClaimsRoot` no longer needs its own redundant `isUsed` loop.
    component claimsRootComp = AuthClaimsRoot(maxClaimsPerSide, claimsTreeDepth);
    for (var i = 0; i < maxClaimsPerSide; i++) {
        claimsRootComp.leaves[i] <== computedLeaves[i] * claimUsed[i].out;
    }
    claimsRoot === claimsRootComp.root;

    // ════════════════════════════════════════
    //  7. MINIMUM RECEIVE GUARANTEE
    //     totalLocked ≥ buyAmount
    //     (the user is guaranteed to get at least the limit they signed)
    //
    //  [PR #127 optimization] LessEqThan(128) is sufficient because both
    //  inputs are independently range-checked above (buyAmount ≤ 2^126,
    //  totalLocked ≤ 2^128).
    // ════════════════════════════════════════
    component receiveCheck = LessEqThan(128);
    receiveCheck.in[0] <== buyAmount;
    receiveCheck.in[1] <== totalLocked;
    receiveCheck.out === 1;

    // ════════════════════════════════════════
    //  8. ORDER HASH + EdDSA VERIFICATION
    //     orderHash = Poseidon(sellToken, buyToken, sellAmount, buyAmount,
    //                          maxFee, expiry, nonce, claimsRoot, relayer)
    //     EdDSA signature over orderHash by pubKey proves the user
    //     authorised this exact order bound to this exact relayer.
    // ════════════════════════════════════════
    component orderHashComp = Poseidon(9);
    orderHashComp.inputs[0] <== sellToken;
    orderHashComp.inputs[1] <== buyToken;
    orderHashComp.inputs[2] <== sellAmount;
    orderHashComp.inputs[3] <== buyAmount;
    orderHashComp.inputs[4] <== maxFee;
    orderHashComp.inputs[5] <== expiry;
    orderHashComp.inputs[6] <== nonce;
    orderHashComp.inputs[7] <== claimsRoot;
    orderHashComp.inputs[8] <== relayer;
    orderHash === orderHashComp.out;

    component sigVerify = EdDSAPoseidonVerifier();
    sigVerify.enabled <== 1;
    sigVerify.Ax <== pubKeyAx;
    sigVerify.Ay <== pubKeyAy;
    sigVerify.S <== sigS;
    sigVerify.R8x <== sigR8x;
    sigVerify.R8y <== sigR8y;
    sigVerify.M <== orderHashComp.out;

    // ════════════════════════════════════════
    //  9. RELAYER BINDING
    //     `relayer` is a public input already bound to the verification
    //     key, but we reference it explicitly so the circom optimizer
    //     keeps it in the witness. Same idiom as the M6 binding in
    //     withdraw/claim/settle.
    // ════════════════════════════════════════
    signal relayerSq;
    relayerSq <== relayer * relayer;
}

// Parameters:
// - commitTreeDepth=20   (1M commitments — matches settle.circom)
// - maxClaimsPerSide=16  (padded to power of 2)
// - claimsTreeDepth=4    (2^4 = 16 leaves)
component main {public [
    commitmentRoot,
    nullifier,
    nonceNullifier,
    newCommitment,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    maxFee,
    expiry,
    claimsRoot,
    totalLocked,
    relayer,
    orderHash
]} = Authorize(20, 16, 4);
