pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";
include "./tags.circom";

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
    //
    //  [issue #128] Commitment binds the BabyJub signing pubkey so a
    //  leaked `(secret, sellToken, balance, salt)` cannot be spent with
    //  a swapped key. deposit.circom validated curve membership and
    //  rejected identity points, so we treat makerPubKeyAx/Ay as
    //  well-formed here.
    // ════════════════════════════════════════
    component makerCommitHash = Poseidon(7);
    makerCommitHash.inputs[0] <== TAG_COMMITMENT_V2();
    makerCommitHash.inputs[1] <== makerSecret;
    makerCommitHash.inputs[2] <== makerSellToken;
    makerCommitHash.inputs[3] <== makerBalance;
    makerCommitHash.inputs[4] <== makerSalt;
    makerCommitHash.inputs[5] <== makerPubKeyAx;
    makerCommitHash.inputs[6] <== makerPubKeyAy;

    component makerMerkle = PoseidonMerkleProof(commitTreeDepth);
    makerMerkle.leaf <== makerCommitHash.out;
    for (var i = 0; i < commitTreeDepth; i++) {
        makerMerkle.pathElements[i] <== makerPath[i];
        makerMerkle.pathIndices[i] <== makerPathIdx[i];
    }
    commitmentRoot === makerMerkle.root;

    // ════════════════════════════════════════
    //  2. COMMITMENT MEMBERSHIP (Taker) — same v2 binding as maker
    // ════════════════════════════════════════
    component takerCommitHash = Poseidon(7);
    takerCommitHash.inputs[0] <== TAG_COMMITMENT_V2();
    takerCommitHash.inputs[1] <== takerSecret;
    takerCommitHash.inputs[2] <== takerSellToken;
    takerCommitHash.inputs[3] <== takerBalance;
    takerCommitHash.inputs[4] <== takerSalt;
    takerCommitHash.inputs[5] <== takerPubKeyAx;
    takerCommitHash.inputs[6] <== takerPubKeyAy;

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
    //
    //  [PR #124 review] Tag values come from the shared `tags.circom`
    //  helper so settle / withdraw / claim cannot drift from each other.
    //  See `circuits/tags.circom` and the matching off-chain modules
    //  `zk-relayer/src/core/tags.ts` and `frontend/app/lib/zk/tags.ts`.
    //  TAG_ESCROW_NULL() / TAG_NONCE_NULL() are inlined circom functions
    //  with zero constraint cost.
    // ════════════════════════════════════════

    component makerNullComp = Poseidon(3);
    makerNullComp.inputs[0] <== TAG_ESCROW_NULL();
    makerNullComp.inputs[1] <== makerSecret;
    makerNullComp.inputs[2] <== makerSalt;
    makerNullifier === makerNullComp.out;

    component takerNullComp = Poseidon(3);
    takerNullComp.inputs[0] <== TAG_ESCROW_NULL();
    takerNullComp.inputs[1] <== takerSecret;
    takerNullComp.inputs[2] <== takerSalt;
    takerNullifier === takerNullComp.out;

    // Nonce nullifiers (prevent replay)
    component makerNonceNull = Poseidon(3);
    makerNonceNull.inputs[0] <== TAG_NONCE_NULL();
    makerNonceNull.inputs[1] <== makerSecret;
    makerNonceNull.inputs[2] <== makerNonce;
    makerNonceNullifier === makerNonceNull.out;

    component takerNonceNull = Poseidon(3);
    takerNonceNull.inputs[0] <== TAG_NONCE_NULL();
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
    // [M1, gemini review fix, 2026-04-10 audit] Range-check the four trade
    // amounts to 126 bits.
    //
    // The previous version used Num2Bits(128). 128-bit × 128-bit can reach
    // 2^256, which exceeds the BN254 scalar modulus r ≈ 2^253.86 and would
    // wrap around the field — making the LessEqThan(252) comparison below
    // give the wrong answer for adversarially-chosen amounts.
    //
    // Reducing to 126 bits caps each amount at 2^126 - 1, so each product
    // is bounded by (2^126 - 1)^2 ≈ 2^252 - 2^127, which matches the
    // `LessEqThan(252)` internal representation exactly. Note that the
    // LessEqThan(252) template internally computes
    //     n2b.in = in[0] + 2^252 - in[1]
    // and calls Num2Bits(253) on it. With both products bounded by
    // (2^126 - 1)^2, the worst case (in[0] ≈ 2^252 - 2^127, in[1] = 0)
    // gives n2b.in ≈ 2·2^252 - 2^127 - 1 ≈ 2^253 - 2^127, which fits in
    // 253 bits and is inside the field modulus by log2(r/2^253) ≈ 0.86
    // bits. This is the tightest place in the circuit.
    //
    // CONSEQUENCES — do not undo this without re-running the bit-width
    // audit at docs/circuit-split/bit-width-audit.md:
    //  1. Do not widen any of the four trade-amount range checks past
    //     126 bits. Even 127 bits would break LessEqThan(252) silently.
    //  2. Do not multiply makerProduct or takerProduct by any further
    //     factor (e.g., a relative haircut or a second-order fee term).
    //     That would push the chain past 253 bits.
    //  3. Do not add makerProduct to any value that could approach 2^252.
    //     Addition alone keeps the sum < 2^253 (so at most 253 bits and
    //     still inside the field), but any subsequent LessEqThan(252) on
    //     the sum would fail because its internal Num2Bits(253) would see
    //     a value ≥ 2^253.
    //  4. Fees are on a disjoint multiplication path
    //     (sellAmount × feeBps ≤ 142 bits) and are comfortably safe.
    //     Do not merge the fee computation with the price computation.
    //
    // Range-check costs for widening the four amounts back to 128 bits
    // would be negligible (~8 constraints), but the correctness cost is
    // infinite: there is no way to fit 128×128 = 256 bits into the field.
    //
    // Other 128-bit checks below (balances, totalLocked, fees) are kept
    // at 128 bits because they only get multiplied by 16-bit fee bps,
    // where 128 + 16 = 144 bits is comfortably inside the field.
    component rcMakerSell = Num2Bits(126);
    rcMakerSell.in <== makerSellAmount;
    component rcMakerBuy = Num2Bits(126);
    rcMakerBuy.in <== makerBuyAmount;
    component rcTakerSell = Num2Bits(126);
    rcTakerSell.in <== takerSellAmount;
    component rcTakerBuy = Num2Bits(126);
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

    // [H-5] claimCount range checks: must be 0..maxClaimsPerSide.
    // Without this, a field-arithmetic overflow could bypass the
    // LessThan(252) gate in the claim-used loops below.
    component rcMakerClaimCount = Num2Bits(5);
    rcMakerClaimCount.in <== makerClaimCount;
    component makerClaimCountBound = LessEqThan(5);
    makerClaimCountBound.in[0] <== makerClaimCount;
    makerClaimCountBound.in[1] <== maxClaimsPerSide;
    makerClaimCountBound.out === 1;

    component rcTakerClaimCount = Num2Bits(5);
    rcTakerClaimCount.in <== takerClaimCount;
    component takerClaimCountBound = LessEqThan(5);
    takerClaimCountBound.in[0] <== takerClaimCount;
    takerClaimCountBound.in[1] <== maxClaimsPerSide;
    takerClaimCountBound.out === 1;

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

    // [M1, gemini review fix] Range-check every claim amount to 128 bits
    // before accumulating them into totalLockedMaker. Without this, an
    // attacker controlling the prover could feed near-modulus values that
    // wrap during the running sum and produce a totalLockedMaker that does
    // not reflect the real claim distribution. With each claim bounded to
    // 2^128 and at most maxClaimsPerSide = 16 entries, the sum is at most
    // 16 × 2^128 = 2^132, well inside the BN254 field.
    component rcMakerClaimAmount[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        rcMakerClaimAmount[i] = Num2Bits(128);
        rcMakerClaimAmount[i].in <== makerClaimAmounts[i];
    }

    // Unused claims (i >= count) must have amount = 0.
    // Used claims must have token == tokenMaker (the token maker receives).
    // [Security fix 2026-04-10] Without the token check, a malicious relayer
    // could construct claim leaves denominated in a worthless token while
    // the public tokenMaker signal indicates a valuable token.
    // [H-5] Now that makerClaimCount is range-checked to 0..16,
    // LessThan(5) is sufficient (was LessThan(252), saving ~247
    // constraints per slot × 16 slots ≈ ~3,950 constraints).
    component makerClaimUsed[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        makerClaimUsed[i] = LessThan(5);
        makerClaimUsed[i].in[0] <== i;
        makerClaimUsed[i].in[1] <== makerClaimCount;
        (1 - makerClaimUsed[i].out) * makerClaimAmounts[i] === 0;
        makerClaimUsed[i].out * (makerClaimTokens[i] - tokenMaker) === 0;
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

    // [M1, gemini review fix] Same 128-bit range check on each taker claim
    // amount as on the maker side above. Prevents sum wrap-around in
    // takerAmountAcc when an attacker controls the prover.
    component rcTakerClaimAmount[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        rcTakerClaimAmount[i] = Num2Bits(128);
        rcTakerClaimAmount[i].in <== takerClaimAmounts[i];
    }

    // [H-5] Same optimization as maker side.
    component takerClaimUsed[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        takerClaimUsed[i] = LessThan(5);
        takerClaimUsed[i].in[0] <== i;
        takerClaimUsed[i].in[1] <== takerClaimCount;
        (1 - takerClaimUsed[i].out) * takerClaimAmounts[i] === 0;
        takerClaimUsed[i].out * (takerClaimTokens[i] - tokenTaker) === 0;
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
    // [issue #128] Residual commitments use the v2 format too — same
    // pubkey the original escrow was deposited with, so the user can
    // later spend the residual with the same key.
    signal makerNewBalance;
    makerNewBalance <== makerBalance - makerSellAmount;

    component makerNewCommitHash = Poseidon(7);
    makerNewCommitHash.inputs[0] <== TAG_COMMITMENT_V2();
    makerNewCommitHash.inputs[1] <== makerSecret;
    makerNewCommitHash.inputs[2] <== makerSellToken;
    makerNewCommitHash.inputs[3] <== makerNewBalance;
    makerNewCommitHash.inputs[4] <== makerNewSalt;
    makerNewCommitHash.inputs[5] <== makerPubKeyAx;
    makerNewCommitHash.inputs[6] <== makerPubKeyAy;

    // If new balance is 0, commitment should be 0
    component makerNewIsZero = IsZero();
    makerNewIsZero.in <== makerNewBalance;
    signal expectedMakerNew;
    expectedMakerNew <== (1 - makerNewIsZero.out) * makerNewCommitHash.out;
    makerNewCommitment === expectedMakerNew;

    signal takerNewBalance;
    takerNewBalance <== takerBalance - takerSellAmount;

    component takerNewCommitHash = Poseidon(7);
    takerNewCommitHash.inputs[0] <== TAG_COMMITMENT_V2();
    takerNewCommitHash.inputs[1] <== takerSecret;
    takerNewCommitHash.inputs[2] <== takerSellToken;
    takerNewCommitHash.inputs[3] <== takerNewBalance;
    takerNewCommitHash.inputs[4] <== takerNewSalt;
    takerNewCommitHash.inputs[5] <== takerPubKeyAx;
    takerNewCommitHash.inputs[6] <== takerPubKeyAy;

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
    //
    //  [PR #124 review note] These checks are NOT redundant with the
    //  contract-level replay protection in PrivateSettlement.settlePrivate.
    //  That function reads `nullifiers[makerNullifier]` and
    //  `nullifiers[takerNullifier]` separately on entry — both reads return
    //  `false` if the nullifier hasn't been spent yet, so a tx with
    //  `makerNullifier == takerNullifier` passes both reads and then
    //  performs two idempotent writes (`nullifiers[X] = true` twice with the
    //  same key). Storage writes don't revert on duplicate writes, so the
    //  contract alone would happily settle a self-trade onto a single UTXO.
    //  The constraint here is the only thing that catches it.
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
