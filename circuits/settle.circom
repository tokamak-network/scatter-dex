pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";

// Reuse from withdraw.circom
template PoseidonMerkleProof(levels) {
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

// Compute Merkle root from array of leaves (fixed size, padded with zeros)
//
// [M5] The internal `isUsed` check below is technically redundant with the
// way the Settle circuit invokes this template: the caller already mutes
// unused leaves to zero (`makerComputedLeaves[i] * makerClaimUsed[i].out`,
// see §9 of the Settle template). We keep the inner check because
// ComputeMerkleRoot is meant to be reusable — future callers must not
// have to re-derive the muting invariant themselves.
//
// [PR #126 review] Real cost: each `LessThan(252)` expands to ~256 R1CS
// constraints, and we instantiate it 16 times for maker + 16 for taker
// = ~8.2k constraints, roughly 13% of the ~64k-constraint settle circuit.
// That's a deliberate trade for the reusability invariant above, not
// "vanishingly small". If we ever decide to keep ComputeMerkleRoot
// internal-only and rely solely on the caller-side muting, the inner
// check can be dropped for an immediate ~13% saving.
template ComputeMerkleRoot(maxLeaves, depth) {
    signal input leaves[maxLeaves];
    signal input count; // actual number of leaves (rest are zero-padded)
    signal output root;

    // Verify unused leaves are zero (prevent padding manipulation)
    component isUsed[maxLeaves];
    for (var i = 0; i < maxLeaves; i++) {
        isUsed[i] = LessThan(252);
        isUsed[i].in[0] <== i;
        isUsed[i].in[1] <== count;
        // If i >= count, leaf must be zero
        (1 - isUsed[i].out) * leaves[i] === 0;
    }

    // Build tree bottom-up
    var layerSize = maxLeaves;
    component hashers[maxLeaves - 1]; // total internal nodes
    signal nodes[depth + 1][maxLeaves]; // nodes at each level

    // Level 0 = leaves
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
        // Zero-pad remaining
        for (var i = nextSize; i < maxLeaves; i++) {
            nodes[level + 1][i] <== 0;
        }
        curSize = nextSize;
    }

    root <== nodes[depth][0];
}

// Main settle circuit
// Proves a valid trade between maker and taker with private balances
template Settle(commitTreeDepth, maxClaimsPerSide, claimsTreeDepth) {
    // ════════════════════════════════════════
    //  PUBLIC INPUTS
    // ════════════════════════════════════════
    signal input commitmentRoot;        // current commitment tree root
    signal input makerNullifier;        // maker's escrow commitment nullifier
    signal input takerNullifier;        // taker's escrow commitment nullifier
    signal input makerNonceNullifier;   // maker's nonce nullifier
    signal input takerNonceNullifier;   // taker's nonce nullifier
    signal input makerNewCommitment;    // maker's new escrow commitment
    signal input takerNewCommitment;    // taker's new escrow commitment
    signal input claimsRootMaker;       // Merkle root of maker's claims
    signal input claimsRootTaker;       // Merkle root of taker's claims
    signal input totalLockedMaker;      // total locked for maker's claims
    signal input totalLockedTaker;      // total locked for taker's claims
    signal input tokenMaker;            // token maker receives (= taker's sell token)
    signal input tokenTaker;            // token taker receives (= maker's sell token)
    signal input feeTokenMaker;         // fee in tokenMaker (from taker's sell) → paid to takerRelayer
    signal input feeTokenTaker;         // fee in tokenTaker (from maker's sell) → paid to makerRelayer
    signal input currentTimestamp;      // block.timestamp for expiry check
    signal input makerRelayer;          // relayer that handles maker's order → receives feeTokenTaker
    signal input takerRelayer;          // relayer that handles taker's order → receives feeTokenMaker

    // ════════════════════════════════════════
    //  PRIVATE INPUTS
    // ════════════════════════════════════════

    // ── Maker escrow commitment ──
    signal input makerSecret;
    signal input makerSellToken;        // what maker is selling
    signal input makerBalance;          // maker's escrow balance
    signal input makerSalt;
    signal input makerPath[commitTreeDepth];
    signal input makerPathIdx[commitTreeDepth];

    // ── Taker escrow commitment ──
    signal input takerSecret;
    signal input takerSellToken;        // what taker is selling
    signal input takerBalance;
    signal input takerSalt;
    signal input takerPath[commitTreeDepth];
    signal input takerPathIdx[commitTreeDepth];

    // ── Order details ──
    signal input makerSellAmount;
    signal input makerBuyAmount;
    signal input makerMaxFee;
    signal input makerExpiry;
    signal input makerNonce;
    signal input takerSellAmount;
    signal input takerBuyAmount;
    signal input takerMaxFee;
    signal input takerExpiry;
    signal input takerNonce;

    // ── Fees ──
    signal input makerFee;              // bps
    signal input takerFee;              // bps

    // ── New commitment salts ──
    signal input makerNewSalt;
    signal input takerNewSalt;

    // ── EdDSA signatures (Baby Jubjub) ──
    signal input makerPubKeyAx;
    signal input makerPubKeyAy;
    signal input makerSigS;
    signal input makerSigR8x;
    signal input makerSigR8y;

    signal input takerPubKeyAx;
    signal input takerPubKeyAy;
    signal input takerSigS;
    signal input takerSigR8x;
    signal input takerSigR8y;

    // ── Claims (maker side) — individual fields for in-circuit validation ──
    signal input makerClaimSecrets[maxClaimsPerSide];
    signal input makerClaimRecipients[maxClaimsPerSide];
    signal input makerClaimTokens[maxClaimsPerSide];
    signal input makerClaimAmounts[maxClaimsPerSide];
    signal input makerClaimReleaseTimes[maxClaimsPerSide];
    signal input makerClaimCount;

    // ── Claims (taker side) ──
    signal input takerClaimSecrets[maxClaimsPerSide];
    signal input takerClaimRecipients[maxClaimsPerSide];
    signal input takerClaimTokens[maxClaimsPerSide];
    signal input takerClaimAmounts[maxClaimsPerSide];
    signal input takerClaimReleaseTimes[maxClaimsPerSide];
    signal input takerClaimCount;

    // ════════════════════════════════════════
    //  1. COMMITMENT MEMBERSHIP (Maker)
    // ════════════════════════════════════════
    component makerCommitHash = Poseidon(4);
    makerCommitHash.inputs[0] <== makerSecret;
    makerCommitHash.inputs[1] <== makerSellToken;
    makerCommitHash.inputs[2] <== makerBalance;
    makerCommitHash.inputs[3] <== makerSalt;

    component makerMerkle = PoseidonMerkleProof(commitTreeDepth);
    makerMerkle.leaf <== makerCommitHash.out;
    for (var i = 0; i < commitTreeDepth; i++) {
        makerMerkle.pathElements[i] <== makerPath[i];
        makerMerkle.pathIndices[i] <== makerPathIdx[i];
    }
    commitmentRoot === makerMerkle.root;

    // ════════════════════════════════════════
    //  2. COMMITMENT MEMBERSHIP (Taker)
    // ════════════════════════════════════════
    component takerCommitHash = Poseidon(4);
    takerCommitHash.inputs[0] <== takerSecret;
    takerCommitHash.inputs[1] <== takerSellToken;
    takerCommitHash.inputs[2] <== takerBalance;
    takerCommitHash.inputs[3] <== takerSalt;

    component takerMerkle = PoseidonMerkleProof(commitTreeDepth);
    takerMerkle.leaf <== takerCommitHash.out;
    for (var i = 0; i < commitTreeDepth; i++) {
        takerMerkle.pathElements[i] <== takerPath[i];
        takerMerkle.pathIndices[i] <== takerPathIdx[i];
    }
    commitmentRoot === takerMerkle.root;

    // ════════════════════════════════════════
    //  3. NULLIFIERS
    // ════════════════════════════════════════
    component makerNullComp = Poseidon(2);
    makerNullComp.inputs[0] <== makerSecret;
    makerNullComp.inputs[1] <== makerSalt;
    makerNullifier === makerNullComp.out;

    component takerNullComp = Poseidon(2);
    takerNullComp.inputs[0] <== takerSecret;
    takerNullComp.inputs[1] <== takerSalt;
    takerNullifier === takerNullComp.out;

    // Nonce nullifiers (prevent replay)
    component makerNonceNull = Poseidon(2);
    makerNonceNull.inputs[0] <== makerSecret;
    makerNonceNull.inputs[1] <== makerNonce;
    makerNonceNullifier === makerNonceNull.out;

    component takerNonceNull = Poseidon(2);
    takerNonceNull.inputs[0] <== takerSecret;
    takerNonceNull.inputs[1] <== takerNonce;
    takerNonceNullifier === takerNonceNull.out;

    // ════════════════════════════════════════
    //  4. TOKEN COMPATIBILITY
    // ════════════════════════════════════════
    // maker sells tokenTaker, receives tokenMaker
    // taker sells tokenMaker, receives tokenTaker
    makerSellToken === tokenTaker;
    takerSellToken === tokenMaker;

    // ════════════════════════════════════════
    //  5. PRICE COMPATIBILITY
    //    maker.sell * taker.sell >= maker.buy * taker.buy
    //    (taker offers at least maker's minimum price)
    //
    //  [M2] Note: this check is *strictly redundant* with the
    //  combination of:
    //    - receive guarantees in §8b (totalLockedMaker >= makerBuyAmount,
    //      totalLockedTaker >= takerBuyAmount), and
    //    - the claim/fee caps in §8c (totalLockedMaker + feeTokenMaker
    //      <= takerSellAmount, totalLockedTaker + feeTokenTaker
    //      <= makerSellAmount).
    //  Multiplying those four inequalities yields the price-product
    //  inequality below (with `fee = 0` it is exact). We keep the
    //  explicit check for defense-in-depth and as documentation of
    //  the trade's economic intent — its constraint cost is negligible
    //  compared to the rest of the circuit.
    // ════════════════════════════════════════
    // Range-check all four amounts to 128 bits so their products fit
    // within 256 bits (well within the ~254-bit BN254 field).
    component rcMakerSell = Num2Bits(128);
    rcMakerSell.in <== makerSellAmount;
    component rcMakerBuy = Num2Bits(128);
    rcMakerBuy.in <== makerBuyAmount;
    component rcTakerSell = Num2Bits(128);
    rcTakerSell.in <== takerSellAmount;
    component rcTakerBuy = Num2Bits(128);
    rcTakerBuy.in <== takerBuyAmount;

    signal makerProduct;
    makerProduct <== makerSellAmount * takerSellAmount;
    signal takerProduct;
    takerProduct <== makerBuyAmount * takerBuyAmount;

    // maker.sell * taker.sell >= maker.buy * taker.buy
    // (taker offers at least maker's minimum price)
    component priceCheck = LessEqThan(252);
    priceCheck.in[0] <== takerProduct;
    priceCheck.in[1] <== makerProduct;
    priceCheck.out === 1;

    // ════════════════════════════════════════
    //  6. EXPIRY CHECK
    // ════════════════════════════════════════
    component makerExpiryCheck = LessEqThan(252);
    makerExpiryCheck.in[0] <== currentTimestamp;
    makerExpiryCheck.in[1] <== makerExpiry;
    makerExpiryCheck.out === 1;

    component takerExpiryCheck = LessEqThan(252);
    takerExpiryCheck.in[0] <== currentTimestamp;
    takerExpiryCheck.in[1] <== takerExpiry;
    takerExpiryCheck.out === 1;

    // ════════════════════════════════════════
    //  7. FEE VALIDATION
    // ════════════════════════════════════════
    // Range-check fee bps to 16 bits (max 65535, well above 10000=100%)
    // Prevents field overflow in makerSellAmount * makerFee multiplication
    component rcMakerFee = Num2Bits(16);
    rcMakerFee.in <== makerFee;
    component rcTakerFee = Num2Bits(16);
    rcTakerFee.in <== takerFee;

    component makerFeeCheck = LessEqThan(252);
    makerFeeCheck.in[0] <== makerFee;
    makerFeeCheck.in[1] <== makerMaxFee;
    makerFeeCheck.out === 1;

    component takerFeeCheck = LessEqThan(252);
    takerFeeCheck.in[0] <== takerFee;
    takerFeeCheck.in[1] <== takerMaxFee;
    takerFeeCheck.out === 1;

    // ── Per-token fee validation ──
    // feeTokenMaker = floor(takerSellAmount * takerFee / 10000)
    //   → fee in tokenMaker, deducted from taker's sell amount
    // feeTokenTaker = floor(makerSellAmount * makerFee / 10000)
    //   → fee in tokenTaker, deducted from maker's sell amount
    // Floor-division check: fee * 10000 <= product < fee * 10000 + 10000

    signal takerFeeProduct;
    takerFeeProduct <== takerSellAmount * takerFee;
    signal feeTokenMakerScaled;
    feeTokenMakerScaled <== feeTokenMaker * 10000;

    component feeTokenMakerLower = LessEqThan(252);
    feeTokenMakerLower.in[0] <== feeTokenMakerScaled;
    feeTokenMakerLower.in[1] <== takerFeeProduct;
    feeTokenMakerLower.out === 1;

    component feeTokenMakerUpper = LessEqThan(252);
    feeTokenMakerUpper.in[0] <== takerFeeProduct;
    feeTokenMakerUpper.in[1] <== feeTokenMakerScaled + 9999;
    feeTokenMakerUpper.out === 1;

    signal makerFeeProduct;
    makerFeeProduct <== makerSellAmount * makerFee;
    signal feeTokenTakerScaled;
    feeTokenTakerScaled <== feeTokenTaker * 10000;

    component feeTokenTakerLower = LessEqThan(252);
    feeTokenTakerLower.in[0] <== feeTokenTakerScaled;
    feeTokenTakerLower.in[1] <== makerFeeProduct;
    feeTokenTakerLower.out === 1;

    component feeTokenTakerUpper = LessEqThan(252);
    feeTokenTakerUpper.in[0] <== makerFeeProduct;
    feeTokenTakerUpper.in[1] <== feeTokenTakerScaled + 9999;
    feeTokenTakerUpper.out === 1;

    // ════════════════════════════════════════
    //  8. BALANCE SUFFICIENCY
    // ════════════════════════════════════════
    component makerBalCheck = LessEqThan(252);
    makerBalCheck.in[0] <== makerSellAmount;
    makerBalCheck.in[1] <== makerBalance;
    makerBalCheck.out === 1;

    component takerBalCheck = LessEqThan(252);
    takerBalCheck.in[0] <== takerSellAmount;
    takerBalCheck.in[1] <== takerBalance;
    takerBalCheck.out === 1;

    // ════════════════════════════════════════
    //  8b. MINIMUM RECEIVE GUARANTEE
    //      Each party receives at least their signed buyAmount.
    //      totalLockedMaker >= makerBuyAmount (maker receives enough)
    //      totalLockedTaker >= takerBuyAmount (taker receives enough)
    // ════════════════════════════════════════
    component makerReceiveCheck = LessEqThan(252);
    makerReceiveCheck.in[0] <== makerBuyAmount;
    makerReceiveCheck.in[1] <== totalLockedMaker;
    makerReceiveCheck.out === 1;

    component takerReceiveCheck = LessEqThan(252);
    takerReceiveCheck.in[0] <== takerBuyAmount;
    takerReceiveCheck.in[1] <== totalLockedTaker;
    takerReceiveCheck.out === 1;

    // ════════════════════════════════════════
    //  8c. CLAIMS + FEES DO NOT EXCEED SELL AMOUNTS
    //      totalLockedMaker + feeTokenMaker <= takerSellAmount
    //      totalLockedTaker + feeTokenTaker <= makerSellAmount
    //      (prevents inflated claims/fees from draining the pool)
    // ════════════════════════════════════════
    signal makerClaimPlusFee;
    makerClaimPlusFee <== totalLockedMaker + feeTokenMaker;
    component makerClaimCap = LessEqThan(252);
    makerClaimCap.in[0] <== makerClaimPlusFee;
    makerClaimCap.in[1] <== takerSellAmount;
    makerClaimCap.out === 1;

    signal takerClaimPlusFee;
    takerClaimPlusFee <== totalLockedTaker + feeTokenTaker;
    component takerClaimCap = LessEqThan(252);
    takerClaimCap.in[0] <== takerClaimPlusFee;
    takerClaimCap.in[1] <== makerSellAmount;
    takerClaimCap.out === 1;

    // ════════════════════════════════════════
    //  9. CLAIMS VALIDATION (trustless)
    //     Compute leaf hashes in-circuit, verify roots, enforce amount sums.
    // ════════════════════════════════════════

    // ── Maker claims ──
    // Compute each claim leaf hash: Poseidon(secret, recipient, token, amount, releaseTime)
    component makerLeafHash[maxClaimsPerSide];
    signal makerComputedLeaves[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        makerLeafHash[i] = Poseidon(5);
        makerLeafHash[i].inputs[0] <== makerClaimSecrets[i];
        makerLeafHash[i].inputs[1] <== makerClaimRecipients[i];
        makerLeafHash[i].inputs[2] <== makerClaimTokens[i];
        makerLeafHash[i].inputs[3] <== makerClaimAmounts[i];
        makerLeafHash[i].inputs[4] <== makerClaimReleaseTimes[i];
        makerComputedLeaves[i] <== makerLeafHash[i].out;
    }

    // Unused claims (i >= count) must have amount = 0
    component makerClaimUsed[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        makerClaimUsed[i] = LessThan(252);
        makerClaimUsed[i].in[0] <== i;
        makerClaimUsed[i].in[1] <== makerClaimCount;
        (1 - makerClaimUsed[i].out) * makerClaimAmounts[i] === 0;
    }

    // Sum maker claim amounts
    signal makerAmountAcc[maxClaimsPerSide + 1];
    makerAmountAcc[0] <== 0;
    for (var i = 0; i < maxClaimsPerSide; i++) {
        makerAmountAcc[i + 1] <== makerAmountAcc[i] + makerClaimAmounts[i];
    }
    totalLockedMaker === makerAmountAcc[maxClaimsPerSide];

    // Verify maker claims Merkle root
    // Zero out unused leaves: ComputeMerkleRoot requires leaves[i] == 0 for i >= count,
    // but Poseidon(0,0,0,0,0) != 0, so we multiply by the isUsed flag.
    component makerClaimsRoot = ComputeMerkleRoot(maxClaimsPerSide, claimsTreeDepth);
    for (var i = 0; i < maxClaimsPerSide; i++) {
        makerClaimsRoot.leaves[i] <== makerComputedLeaves[i] * makerClaimUsed[i].out;
    }
    makerClaimsRoot.count <== makerClaimCount;
    claimsRootMaker === makerClaimsRoot.root;

    // ── Taker claims ──
    component takerLeafHash[maxClaimsPerSide];
    signal takerComputedLeaves[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        takerLeafHash[i] = Poseidon(5);
        takerLeafHash[i].inputs[0] <== takerClaimSecrets[i];
        takerLeafHash[i].inputs[1] <== takerClaimRecipients[i];
        takerLeafHash[i].inputs[2] <== takerClaimTokens[i];
        takerLeafHash[i].inputs[3] <== takerClaimAmounts[i];
        takerLeafHash[i].inputs[4] <== takerClaimReleaseTimes[i];
        takerComputedLeaves[i] <== takerLeafHash[i].out;
    }

    component takerClaimUsed[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        takerClaimUsed[i] = LessThan(252);
        takerClaimUsed[i].in[0] <== i;
        takerClaimUsed[i].in[1] <== takerClaimCount;
        (1 - takerClaimUsed[i].out) * takerClaimAmounts[i] === 0;
    }

    signal takerAmountAcc[maxClaimsPerSide + 1];
    takerAmountAcc[0] <== 0;
    for (var i = 0; i < maxClaimsPerSide; i++) {
        takerAmountAcc[i + 1] <== takerAmountAcc[i] + takerClaimAmounts[i];
    }
    totalLockedTaker === takerAmountAcc[maxClaimsPerSide];

    component takerClaimsRoot = ComputeMerkleRoot(maxClaimsPerSide, claimsTreeDepth);
    for (var i = 0; i < maxClaimsPerSide; i++) {
        takerClaimsRoot.leaves[i] <== takerComputedLeaves[i] * takerClaimUsed[i].out;
    }
    takerClaimsRoot.count <== takerClaimCount;
    claimsRootTaker === takerClaimsRoot.root;

    // ════════════════════════════════════════
    //  10. NEW COMMITMENTS (after balance deduction)
    // ════════════════════════════════════════
    signal makerNewBalance;
    makerNewBalance <== makerBalance - makerSellAmount;

    component makerNewCommitHash = Poseidon(4);
    makerNewCommitHash.inputs[0] <== makerSecret;
    makerNewCommitHash.inputs[1] <== makerSellToken;
    makerNewCommitHash.inputs[2] <== makerNewBalance;
    makerNewCommitHash.inputs[3] <== makerNewSalt;

    // If new balance is 0, commitment should be 0
    component makerNewIsZero = IsZero();
    makerNewIsZero.in <== makerNewBalance;
    signal expectedMakerNew;
    expectedMakerNew <== (1 - makerNewIsZero.out) * makerNewCommitHash.out;
    makerNewCommitment === expectedMakerNew;

    signal takerNewBalance;
    takerNewBalance <== takerBalance - takerSellAmount;

    component takerNewCommitHash = Poseidon(4);
    takerNewCommitHash.inputs[0] <== takerSecret;
    takerNewCommitHash.inputs[1] <== takerSellToken;
    takerNewCommitHash.inputs[2] <== takerNewBalance;
    takerNewCommitHash.inputs[3] <== takerNewSalt;

    component takerNewIsZero = IsZero();
    takerNewIsZero.in <== takerNewBalance;
    signal expectedTakerNew;
    expectedTakerNew <== (1 - takerNewIsZero.out) * takerNewCommitHash.out;
    takerNewCommitment === expectedTakerNew;

    // ════════════════════════════════════════
    //  11. EdDSA SIGNATURE VERIFICATION
    //      Verify maker/taker signed their order
    // ════════════════════════════════════════
    // Order hash = Poseidon(sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce, claimsRoot, relayer)
    // Including claimsRoot prevents the relayer from manipulating claim recipients.
    // Including relayer binds the order to a specific relayer for trustless fee split.
    component makerOrderHash = Poseidon(9);
    makerOrderHash.inputs[0] <== makerSellToken;
    makerOrderHash.inputs[1] <== tokenMaker; // buyToken = what maker receives
    makerOrderHash.inputs[2] <== makerSellAmount;
    makerOrderHash.inputs[3] <== makerBuyAmount;
    makerOrderHash.inputs[4] <== makerMaxFee;
    makerOrderHash.inputs[5] <== makerExpiry;
    makerOrderHash.inputs[6] <== makerNonce;
    makerOrderHash.inputs[7] <== claimsRootMaker;
    makerOrderHash.inputs[8] <== makerRelayer;

    component makerSigVerify = EdDSAPoseidonVerifier();
    makerSigVerify.enabled <== 1;
    makerSigVerify.Ax <== makerPubKeyAx;
    makerSigVerify.Ay <== makerPubKeyAy;
    makerSigVerify.S <== makerSigS;
    makerSigVerify.R8x <== makerSigR8x;
    makerSigVerify.R8y <== makerSigR8y;
    makerSigVerify.M <== makerOrderHash.out;
    // EdDSAPoseidonVerifier asserts internally when enabled=1; no explicit output check needed.

    component takerOrderHash = Poseidon(9);
    takerOrderHash.inputs[0] <== takerSellToken;
    takerOrderHash.inputs[1] <== tokenTaker; // buyToken
    takerOrderHash.inputs[2] <== takerSellAmount;
    takerOrderHash.inputs[3] <== takerBuyAmount;
    takerOrderHash.inputs[4] <== takerMaxFee;
    takerOrderHash.inputs[5] <== takerExpiry;
    takerOrderHash.inputs[6] <== takerNonce;
    takerOrderHash.inputs[7] <== claimsRootTaker;
    takerOrderHash.inputs[8] <== takerRelayer;

    component takerSigVerify = EdDSAPoseidonVerifier();
    takerSigVerify.enabled <== 1;
    takerSigVerify.Ax <== takerPubKeyAx;
    takerSigVerify.Ay <== takerPubKeyAy;
    takerSigVerify.S <== takerSigS;
    takerSigVerify.R8x <== takerSigR8x;
    takerSigVerify.R8y <== takerSigR8y;
    takerSigVerify.M <== takerOrderHash.out;

    // ════════════════════════════════════════
    //  12. SELF-TRADE PREVENTION
    // ════════════════════════════════════════
    component notSamePubX = IsEqual();
    notSamePubX.in[0] <== makerPubKeyAx;
    notSamePubX.in[1] <== takerPubKeyAx;

    component notSamePubY = IsEqual();
    notSamePubY.in[0] <== makerPubKeyAy;
    notSamePubY.in[1] <== takerPubKeyAy;

    // If both X and Y match, it's the same key → reject
    signal sameKey;
    sameKey <== notSamePubX.out * notSamePubY.out;
    sameKey === 0;

    // ════════════════════════════════════════
    //  13. RELAYER BINDING
    //      Bind both relayer addresses to proof for trustless fee split.
    //      Each relayer is also included in the order hash (signed by user),
    //      so they cannot be changed without invalidating the EdDSA signature.
    //
    //  [M6] `makerRelayer` and `takerRelayer` are public inputs and are
    //  therefore already bound to the proof at the verification-key level.
    //  The squaring statements below exist to prevent the circom optimizer
    //  from dropping these signals from the witness — without at least
    //  one constraint that *uses* them, the compiler may consider them
    //  dead and elide them, leading to verification keys that no longer
    //  cover the public inputs.
    //
    //  The choice of `x * x` is the simplest constraint that touches
    //  every bit of the input without leaking any structural information.
    //  See: https://docs.circom.io/circom-language/signals/#unused-signals
    // ════════════════════════════════════════
    signal makerRelayerSq;
    makerRelayerSq <== makerRelayer * makerRelayer;
    signal takerRelayerSq;
    takerRelayerSq <== takerRelayer * takerRelayer;
}

// Parameters:
// - commitTreeDepth=20 (1M commitments)
// - maxClaimsPerSide=16 (padded to power of 2, supports up to 10 actual claims)
// - claimsTreeDepth=4 (2^4=16 leaves per side)
component main {public [
    commitmentRoot,
    makerNullifier, takerNullifier,
    makerNonceNullifier, takerNonceNullifier,
    makerNewCommitment, takerNewCommitment,
    claimsRootMaker, claimsRootTaker,
    totalLockedMaker, totalLockedTaker,
    tokenMaker, tokenTaker,
    feeTokenMaker, feeTokenTaker, currentTimestamp,
    makerRelayer, takerRelayer
]} = Settle(20, 16, 4);
