pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";
include "./tags.circom";

// ════════════════════════════════════════════════════════════════════
//  authorize.circom — Half-proof trustless settlement primitive
//
//  Each user independently proves "I authorise spending `sellAmount` of
//  tokenX out of my escrow, in exchange for at least `buyAmount` of
//  tokenY distributed to these claims". The relayer matches two
//  authorize proofs and submits them as a single
//  `settleAuth(makerProof, takerProof)` transaction, never seeing:
//    - the user's escrow secret / salt
//    - the user's balance
//    - the claim secrets
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
//  ── pubkey binding & the deliberate absence of pubKeyHash ──
//
//  [issue #128 — full fix landed] The commitment now binds the BabyJub
//  signing pubkey directly into its preimage via
//  `Poseidon(TAG_COMMITMENT_V2, secret, sellToken, balance, salt,
//            pubKeyAx, pubKeyAy)`.
//  A leaked `(secret, sellToken, balance, salt)` is no longer enough
//  to forge a proof: the merkle membership check inside this circuit
//  will reject any commitment computed with a swapped pubkey, and the
//  attacker cannot re-sign `orderHash` without the EdDSA private key.
//  See `issue #128` for the full threat analysis.
//
//  [issue #128 design correction] An earlier draft of this circuit
//  exposed `pubKeyHash = Poseidon(pubKeyAx, pubKeyAy)` as a public
//  output to serve two purposes:
//
//    (a) Self-trade detection in a future `settleAuth` glue contract.
//    (b) Defence-in-depth against the swap-the-pubkey attack.
//
//  Both justifications fail under scrutiny:
//
//    (b) is redundant after the v2 commitment binding — an attacker
//        cannot swap the pubkey without breaking merkle membership,
//        so the contract doesn't need a separate hash to compare.
//
//    (a) is worse than useless. Publishing a per-trader hash on every
//        proof turns the public signal into a linkability oracle: a
//        chain-analysis tool can group every trade that shares the
//        same `pubKeyHash` and then combine that clustering with the
//        plaintext `claimRecipients` (which are ERC20 addresses) to
//        reconstruct wallet graphs — the exact deanonymization path
//        that Tornado Cash failed to close. And the on-chain
//        self-trade check it would enable is not something the
//        contract *has* to enforce: self-trading an escrow can't
//        break fund integrity (the nullifier already prevents
//        double-spend), and wash-trading / rebate-gaming are
//        off-chain metrics problems a relayer can filter on its own.
//
//  The principled answer is to keep the pubkey *out* of any public
//  signal. The binding lives entirely inside the merkle membership
//  check, and self-trade prevention — if needed at all — happens in
//  the relayer's off-chain orderbook, where the pubkey is already
//  visible to the relayer but not to the rest of the world.
//
//  deposit.circom is the canonical place where the pubkey is validated
//  (BabyCheck + identity rejection). Downstream circuits
//  (withdraw/authorize/cancel/claim) rely on the invariant that every
//  commitment in the merkle tree was produced by a well-formed pubkey.
//
//  See: project_half_proof_design.md for the full context on how this
//  folds into the trustless settlement flow.
// ════════════════════════════════════════════════════════════════════

// ── Poseidon Merkle membership proof ──
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
// [PR #127 optimization] This template is INTERNAL to authorize.circom
// and the caller (the
// `Authorize` template below) always mutes unused leaves to zero before
// passing them in. We therefore drop the inner `isUsed`/`LessThan(252)`
// loop entirely, saving ~4 000 R1CS constraints (~13% of the unoptimized
// authorize circuit).
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
    //  Bounds established by PR #124's gemini HIGH fix:
    //  - trade amounts (sell/buy) bounded to 126 bits so products fit
    //    the BN254 field after a future off-chain priceCheck
    //  - balance / totalLocked / individual claim amounts to 128 bits
    //  - maxFee to 16 bits (bps)
    //
    //  [2026-04-10 audit] The 126-bit cap is a hard correctness boundary.
    //  `settleAuth` computes `makerSellAmount * takerSellAmount` in
    //  Solidity uint256 during cross-side price checks. That
    //  multiplication fits even for full uint128 operands
    //  (`(2^128 − 1)^2 < 2^256`), so the reason to keep 126 bits here
    //  is **not** EVM uint256 overflow avoidance.
    //
    //  The real reason is headroom for in-circuit `LessEqThan(252)`
    //  range comparisons on price products — any path that reuses this
    //  tree (settleAuth, settleWithDex, scatterDirectAuth) must refuse
    //  the same set of "too large" amounts. See
    //  `docs/circuit-split/bit-width-audit.md §5` for the full analysis.
    //
    //  Do NOT widen any of these range checks past 126 bits without
    //  re-running that audit.
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
    // [Gemini PR #299 review] Without this cap, a maxFee > 10000 (>100%)
    // would make `(10000 - maxFee)` wrap the field modulus inside the
    // minimum-receive guarantee below, so `buyAmount × (10000 − maxFee)`
    // could underflow to a small positive number and let totalLocked = 0
    // pass the LessEqThan check.
    component maxFeeUpper = LessEqThan(16);
    maxFeeUpper.in[0] <== maxFee;
    maxFeeUpper.in[1] <== 10000;
    maxFeeUpper.out === 1;

    // [H-5] claimCount range check: must be 0..maxClaimsPerSide.
    // Without this, a field-arithmetic overflow could bypass the
    // LessThan(5) gate in the claim-used loop below.
    // Num2Bits(5) constrains to 0..31; LessEqThan(5) tightens to 0..16.
    component rcClaimCount = Num2Bits(5);
    rcClaimCount.in <== claimCount;
    component claimCountBound = LessEqThan(5);
    claimCountBound.in[0] <== claimCount;
    claimCountBound.in[1] <== maxClaimsPerSide;
    claimCountBound.out === 1;

    component rcClaimAmount[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        rcClaimAmount[i] = Num2Bits(128);
        rcClaimAmount[i].in <== claimAmounts[i];
    }

    // ════════════════════════════════════════
    //  2. COMMITMENT MEMBERSHIP
    //     commitment = Poseidon(
    //       TAG_COMMITMENT_V2, secret, sellToken, balance, salt,
    //       pubKeyAx, pubKeyAy
    //     )
    //     ∈ commitmentRoot (Merkle)
    //
    //  [issue #128] The v2 commitment binds the BabyJub signing pubkey
    //  so a swapped pubkey produces a different hash and fails merkle
    //  membership. deposit.circom ran BabyCheck + identity rejection so
    //  every pubKey entering the tree is well-formed.
    // ════════════════════════════════════════
    component commitHash = Poseidon(7);
    commitHash.inputs[0] <== TAG_COMMITMENT_V2();
    commitHash.inputs[1] <== secret;
    commitHash.inputs[2] <== sellToken;
    commitHash.inputs[3] <== balance;
    commitHash.inputs[4] <== salt;
    commitHash.inputs[5] <== pubKeyAx;
    commitHash.inputs[6] <== pubKeyAy;

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

    // Residual commitment uses the same v2 binding — same pubkey, so
    // the residual can be spent later with the same EdDSA key.
    component newCommitHash = Poseidon(7);
    newCommitHash.inputs[0] <== TAG_COMMITMENT_V2();
    newCommitHash.inputs[1] <== secret;
    newCommitHash.inputs[2] <== sellToken;
    newCommitHash.inputs[3] <== newBalance;
    newCommitHash.inputs[4] <== newSalt;
    newCommitHash.inputs[5] <== pubKeyAx;
    newCommitHash.inputs[6] <== pubKeyAy;

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
    //
    // [PR #127 gemini HIGH] Every *used* claim must be paid in `buyToken`.
    // Without this, a buggy or malicious client could sign an order for
    // buyToken=USDC but actually distribute claim leaves denominated in
    // a worthless token, and the proof would still verify because the
    // claims tree only commits to (secret, recipient, token, amount,
    // releaseTime) and totalLocked is a pure sum. The constraint is
    // gated on `claimUsed[i].out` so padding slots (i ≥ claimCount) can
    // still carry their default zero token without failing.
    component claimUsed[maxClaimsPerSide];
    for (var i = 0; i < maxClaimsPerSide; i++) {
        claimUsed[i] = LessThan(5);
        claimUsed[i].in[0] <== i;
        claimUsed[i].in[1] <== claimCount;
        (1 - claimUsed[i].out) * claimAmounts[i] === 0;
        claimUsed[i].out * (claimTokens[i] - buyToken) === 0;
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
    //  7. MINIMUM RECEIVE GUARANTEE (fee-semantics redesign, 2026-04-14)
    //     totalLocked × 10000 ≥ buyAmount × (10000 − maxFee)
    //     ⇔ totalLocked ≥ buyAmount − (buyAmount × maxFee / 10000)
    //     The user's relayer fee is drawn from their own receive side, so
    //     recipients distribute at least the worst-case net:
    //       buyAmount × (1 − maxFee).
    //     At settle time the actual fee may be ≤ maxFee, so totalLocked
    //     (which was fixed here) is always ≥ what the user needs.
    //
    //  Widths: buyAmount ≤ 2^126, maxFee ≤ 2^16, so `buyAmount × (10000 −
    //  maxFee)` fits in 142 bits. `totalLocked × 10000` is ≤ 2^128 × 2^14
    //  = 2^142. LessEqThan(144) is the tightest bound (saves ~108
    //  constraints vs LessEqThan(252)).
    // ════════════════════════════════════════
    signal lockedScaled;
    lockedScaled <== totalLocked * 10000;
    signal minReceiveScaled;
    minReceiveScaled <== buyAmount * (10000 - maxFee);
    component receiveCheck = LessEqThan(144);
    receiveCheck.in[0] <== minReceiveScaled;
    receiveCheck.in[1] <== lockedScaled;
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

    // ════════════════════════════════════════
    //  10. PUBKEY BINDING (compliance)
    //     pubKeyBind = Poseidon(pubKeyAx, pubKeyAy, nullifier)
    //
    //     Purpose: allows the relayer to verify the user's claimed pubKey
    //     without exposing pubKey on-chain. The nullifier is included so
    //     pubKeyBind differs per transaction, preventing cross-trade linking.
    //
    //     On-chain: pubKeyBind looks like a random hash → privacy preserved.
    //     Off-chain: relayer checks Poseidon(claimed_Ax, claimed_Ay, nullifier)
    //                == pubKeyBind → confirms real pubKey.
    //
    //     This enables the regulatory compliance chain:
    //       wallet → pubKey (user provides) → pubKeyBind (circuit verifies)
    //       → relayer logs wallet + pubKey + nullifier + trade details
    //       → law enforcement can trace with pubKey (via relayer subpoena)
    //
    //     Without pubKeyBind, a user could give a fake pubKey to the relayer
    //     and there would be no way to detect it.
    //
    //     PRIVACY NOTE [M-8]: pubKeyBind is per-trade unique (different
    //     nullifier each time), so observers without the user's pubKey cannot link trades.
    //     However, a relayer who knows the user's pubKey CAN recompute
    //     pubKeyBind and link all trades by that user. This is intentional
    //     for compliance. See docs/adr/002-pubkeybind-privacy-tradeoff.md.
    // ════════════════════════════════════════
    component pubKeyBindHasher = Poseidon(3);
    pubKeyBindHasher.inputs[0] <== pubKeyAx;
    pubKeyBindHasher.inputs[1] <== pubKeyAy;
    pubKeyBindHasher.inputs[2] <== nullifier;
    signal output pubKeyBind;
    pubKeyBind <== pubKeyBindHasher.out;
}

// Parameters:
// - commitTreeDepth=20   (1M commitments)
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
// NOTE: pubKeyBind is a `signal output` inside Authorize, so it is
// automatically public in circom 2.x. In the verifier's pubSignals
// array it appears first (index 0), before commitmentRoot and the
// other explicitly listed public signals.
