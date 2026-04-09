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
    //
    //  [M4] Domain-separated to prevent any chance of an escrow nullifier
    //  colliding with a nonce nullifier.  Both used to be Poseidon(2) of
    //  the same secret, which meant a (secret, value) pair could in
    //  principle hash to the same digest under either context.  Adding
    //  a one-byte tag (0 = escrow, 1 = nonce) makes the two preimage
    //  spaces disjoint by construction.
    // ════════════════════════════════════════
    var TAG_ESCROW_NULL = 0;
    var TAG_NONCE_NULL = 1;

    component makerNullComp = Poseidon(3);
    makerNullComp.inputs[0] <== TAG_ESCROW_NULL;
    makerNullComp.inputs[1] <== makerSecret;
    makerNullComp.inputs[2] <== makerSalt;
    makerNullifier === makerNullComp.out;

    component takerNullComp = Poseidon(3);
    takerNullComp.inputs[0] <== TAG_ESCROW_NULL;
    takerNullComp.inputs[1] <== takerSecret;
    takerNullComp.inputs[2] <== takerSalt;
    takerNullifier === takerNullComp.out;

    // Nonce nullifiers (prevent replay)
    component makerNonceNull = Poseidon(3);
    makerNonceNull.inputs[0] <== TAG_NONCE_NULL;
    makerNonceNull.inputs[1] <== makerSecret;
    makerNonceNull.inputs[2] <== makerNonce;
    makerNonceNullifier === makerNonceNull.out;

    component takerNonceNull = Poseidon(3);
    takerNonceNull.inputs[0] <== TAG_NONCE_NULL;
    takerNonceNull.inputs[1] <== takerSecret;
    takerNonceNull.inputs[2] <== takerNonce;
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
    // ════════════════════════════════════════
    // Range-check all amount-like signals to 128 bits.
    //
    // Why: every LessEqThan(252) below assumes its inputs fit in 252 bits.
    // Without explicit Num2Bits checks an attacker could supply field
    // elements larger than 2^128 (e.g. close to the BN254 modulus) and
    // produce wrap-around behavior in the product/comparison gadgets.
    //
    // 128 bits is more than sufficient for any realistic ERC20 amount
    // (uint128 max ≈ 3.4e38, while the largest realistic token supply
    // is ~1e30) and keeps every product within the ~254-bit field.
    component rcMakerSell = Num2Bits(128);
    rcMakerSell.in <== makerSellAmount;
    component rcMakerBuy = Num2Bits(128);
    rcMakerBuy.in <== makerBuyAmount;
    component rcTakerSell = Num2Bits(128);
    rcTakerSell.in <== takerSellAmount;
    component rcTakerBuy = Num2Bits(128);
    rcTakerBuy.in <== takerBuyAmount;

    // [M1] Range-check escrow balances and the locked / fee outputs.
    // These were previously assumed to be well-formed; an attacker
    // controlling the prover could otherwise pass values close to the
    // field modulus through LessEqThan(252) and produce nonsensical
    // comparisons.
    component rcMakerBalance = Num2Bits(128);
    rcMakerBalance.in <== makerBalance;
    component rcTakerBalance = Num2Bits(128);
    rcTakerBalance.in <== takerBalance;
    component rcTotalLockedMaker = Num2Bits(128);
    rcTotalLockedMaker.in <== totalLockedMaker;
    component rcTotalLockedTaker = Num2Bits(128);
    rcTotalLockedTaker.in <== totalLockedTaker;
    component rcFeeTokenMaker = Num2Bits(128);
    rcFeeTokenMaker.in <== feeTokenMaker;
    component rcFeeTokenTaker = Num2Bits(128);
    rcFeeTokenTaker.in <== feeTokenTaker;
    component rcMakerMaxFee = Num2Bits(16);
    rcMakerMaxFee.in <== makerMaxFee;
    component rcTakerMaxFee = Num2Bits(16);
    rcTakerMaxFee.in <== takerMaxFee;

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
    //
    //  Two layers of defence:
    //   (a) reject when both EdDSA pubkeys match (catches the naive case
    //       where a user signs both legs with the same key);
    //   (b) [M3] reject when either escrow nullifier or nonce nullifier
    //       collides between the two sides — that proves the same UTXO /
    //       same nonce slot is being used twice in a single settle.
    //
    //  Sybil resistance against a user holding multiple BabyJubJub
    //  keypairs is intentionally NOT enforced here; that has to be
    //  handled upstream by an identity gate (e.g. RelayerRegistry +
    //  IdentityGate).  These checks make sure the prover cannot collapse
    //  a self-trade onto a single commitment without burning a unique
    //  nullifier per side.
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

    // [M3] Reject if maker/taker reuse the same escrow commitment
    //      (escrow nullifier collision) or the same nonce slot
    //      (nonce nullifier collision).  Without this, a user with one
    //      keypair could in principle pass the pubkey check above by
    //      using two ephemeral keys but still spend the same UTXO twice.
    component sameEscrowNull = IsEqual();
    sameEscrowNull.in[0] <== makerNullifier;
    sameEscrowNull.in[1] <== takerNullifier;
    sameEscrowNull.out === 0;

    component sameNonceNull = IsEqual();
    sameNonceNull.in[0] <== makerNonceNullifier;
    sameNonceNull.in[1] <== takerNonceNullifier;
    sameNonceNull.out === 0;

    // ════════════════════════════════════════
    //  13. RELAYER BINDING
    //      Bind both relayer addresses to proof for trustless fee split.
    //      Each relayer is also included in the order hash (signed by user),
    //      so they cannot be changed without invalidating the EdDSA signature.
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
