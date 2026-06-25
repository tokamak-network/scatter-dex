// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {IBatchAuthorizeVerifier} from "./IBatchAuthorizeVerifier.sol";

/// @title BatchAuthorizeVerifier128
/// @notice Batched Groth16 verification for two authorize.circom proofs.
///         Uses random linear combination (Fiat-Shamir) to reduce from 8 pairings
///         (2×4) to 5 pairings, saving ~24% gas (~145K per settleAuth).
///
/// @dev Batch verification equation:
///
///   r = keccak256(A₁, B₁, C₁, pub₁, A₂, B₂, C₂, pub₂, address(this), block.chainid) mod r
///   e(-A₁, B₁) · e(-r·A₂, B₂) · e(L₁ + r·L₂, γ) · e(C₁ + r·C₂, δ) · e((1+r)·α, β) = 1
///
///   Soundness error: 1/r ≈ 2^{-254} (negligible).
///
///   This contract uses the same verification key as AuthorizeVerifier_128.sol (same circuit,
///   same trusted setup). The vkey constants are duplicated here rather than read from
///   storage to keep everything in assembly for gas efficiency.
///   WARNING: If the circuit is recompiled, both AuthorizeVerifier_128.sol and this file
///   must be regenerated/updated in lock-step.
contract BatchAuthorizeVerifier128 is IBatchAuthorizeVerifier {
    // Scalar field size (BN254)
    uint256 constant r_mod = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size (BN254)
    uint256 constant q_mod = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // ── Verification key (same as AuthorizeVerifier_128.sol (tier 128)) ──
    uint256 constant alphax = 11513112507492176768361146117777289128211748961773152078210324064759564213230;
    uint256 constant alphay = 8463427508639159999674456928984127895481196933468833244954446025114158460906;
    uint256 constant betax1 = 1141182710982301838134717021599958185601640732265256931879319186973494828374;
    uint256 constant betax2 = 10314475193812851897482830893554671740543097586252931091259888872176892686998;
    uint256 constant betay1 = 6589651726143072939032823734628721292683880901142200491604114938776380304735;
    uint256 constant betay2 = 14313159697795065456067802549725149314989352622359173156191517835212621800595;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 14305595585389164895312223556087115812836253226963309581811202203068303477938;
    uint256 constant deltax2 = 90289314968172923675641677337350011687083040410051182630707893103695131632;
    uint256 constant deltay1 = 11878854869508158004844438126559639628848441563807062910939314028922858517409;
    uint256 constant deltay2 = 20537144125901399600734768235834994247389166062973758639890711656838791089637;

    // IC points (15 public signals + IC[0]) — copied verbatim from AuthorizeVerifier_128.sol
    uint256 constant IC0x = 7686940724369243670417182568254064405463350173170174266444840934996583320251;
    uint256 constant IC0y = 1337529490949138921071824090909110754096841517304208508064792440473409506238;
    uint256 constant IC1x = 16552420701177184553432081942905192863287459626131675525818282033760988853007;
    uint256 constant IC1y = 5453110674074311086985587184326835212383275474698297011980101837474756997907;
    uint256 constant IC2x = 9183587980698232129443646104145700952186125662441299673105934124672148346756;
    uint256 constant IC2y = 4968618359486973419881751344799671779632214138460013661888902708316652878132;
    uint256 constant IC3x = 3550094104557904057974977204888237141920848829558049112654704839340553408227;
    uint256 constant IC3y = 5036471131112703888290267723186056715874476212562308795177804981987028381252;
    uint256 constant IC4x = 9113136878202759966063474637561563219854367853964957248506537090760988326890;
    uint256 constant IC4y = 8209081689380037462865011921364441357694673217383985207091723541882113580068;
    uint256 constant IC5x = 15839951846850959462154299253929579065554688969620152495605804678586658037350;
    uint256 constant IC5y = 11036226395477134226483901930688680912988933969891333552115453979524176338832;
    uint256 constant IC6x = 20782939953664848562695789276961865349427491234112797120130345535644226932442;
    uint256 constant IC6y = 2257313830929965496388380992813191739650690859991143305894457028790981063662;
    uint256 constant IC7x = 17802176261694390592069046705962884428749500250609383590109973295889682983944;
    uint256 constant IC7y = 4429082389891125482419521846992743201885295507190138221089907952666901634773;
    uint256 constant IC8x = 8167051818650635165977568169541265279634666555580792416177345978779057998571;
    uint256 constant IC8y = 17492545167171633769824182208017284810337009327983473802650186957036280262227;
    uint256 constant IC9x = 20245542342931054774296511563095701333849496681568811591412064427956411197377;
    uint256 constant IC9y = 19116771413827963318008884620542675228986147792179087991640911133156794678315;
    uint256 constant IC10x = 13661467482077831088139892958662091166297166118197470756134677307803444307869;
    uint256 constant IC10y = 5265587854599305065707869037556048613668895229572197653786055726345649515696;
    uint256 constant IC11x = 7400721819641080445905544513954763173182377905926810389415000702495468607575;
    uint256 constant IC11y = 16131064960126893946991727398440554777525994684337700631540546697786111662901;
    uint256 constant IC12x = 16062093597118158757814651857853964690652919205601315143514145378852944238496;
    uint256 constant IC12y = 16259547918384597340048725604233189768552985918599865290936743473434613534093;
    uint256 constant IC13x = 17757743567075057022459332382533692577411083816702328901202951276851444344162;
    uint256 constant IC13y = 5481863998757955232296519857304255826915148562908355813431383316527693958018;
    uint256 constant IC14x = 18235678085259930726342706429761260854244897660312187255890201336063156099252;
    uint256 constant IC14y = 20399996136989002047822144224719746385909988211779031811578892010342599635835;
    uint256 constant IC15x = 634494100991972241131479699401740565992746381484363307181271285830406166074;
    uint256 constant IC15y = 14187091145912559045981269218701498344549503890526140735788354635215141962876;

    /// @notice Batch-verify two Groth16 proofs from authorize.circom.
    /// @param _pA1 Proof 1 point A (G1)
    /// @param _pB1 Proof 1 point B (G2)
    /// @param _pC1 Proof 1 point C (G1)
    /// @param _pubSignals1 Proof 1 public signals (15 elements)
    /// @param _pA2 Proof 2 point A (G1)
    /// @param _pB2 Proof 2 point B (G2)
    /// @param _pC2 Proof 2 point C (G1)
    /// @param _pubSignals2 Proof 2 public signals (15 elements)
    /// @return result True if both proofs are valid
    function verifyBatchProof(
        uint256[2] calldata _pA1,
        uint256[2][2] calldata _pB1,
        uint256[2] calldata _pC1,
        uint256[15] calldata _pubSignals1,
        uint256[2] calldata _pA2,
        uint256[2][2] calldata _pB2,
        uint256[2] calldata _pC2,
        uint256[15] calldata _pubSignals2
    ) public view returns (bool result) {
        // Batched 5-pairing verification via random linear combination.
        //   r = keccak256(proofs, address(this), chainid) mod r_mod
        //   e(-A₁, B₁) · e(-r·A₂, B₂) · e(L₁+r·L₂, γ) · e(C₁+r·C₂, δ) · e((1+r)·α, β) = 1
        // Saves ~145K gas vs 2× separate verify (~24% reduction).
        assembly {
            function g1_mulAccC(pR, x, y, s) -> ok {
                ok := 1
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)
                let success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)
                if iszero(success) {
                    ok := 0
                    leave
                }
                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))
                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)
                if iszero(success) {
                    ok := 0
                    leave
                }
            }

            function g1_mul(pOut, x, y, s) -> ok {
                ok := 1
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)
                let success := staticcall(sub(gas(), 2000), 7, mIn, 96, pOut, 64)
                if iszero(success) { ok := 0 }
            }

            function g1_add(pOut, ax, ay, bx, by) -> ok {
                ok := 1
                let mIn := mload(0x40)
                mstore(mIn, ax)
                mstore(add(mIn, 32), ay)
                mstore(add(mIn, 64), bx)
                mstore(add(mIn, 96), by)
                let success := staticcall(sub(gas(), 2000), 6, mIn, 128, pOut, 64)
                if iszero(success) { ok := 0 }
            }

            function doBatchVerify(pA1, pB1, pC1, pub1, pA2, pB2, pC2, pub2) -> isOk {
                isOk := 0

                // 1. Validate all 30 public signals ∈ F
                for { let i := 0 } lt(i, 15) { i := add(i, 1) } {
                    if iszero(lt(calldataload(add(pub1, mul(i, 32))), r_mod)) { leave }
                    if iszero(lt(calldataload(add(pub2, mul(i, 32))), r_mod)) { leave }
                }

                // 1b. Validate pA1.y < q_mod. It is negated as
                // mod(q_mod - y, q_mod) before the pairing input, so a y ≥ q_mod
                // would alias a valid proof to a second encoding (malleability).
                // Every other point coordinate reaches ecMul / ecAdd / ecPairing
                // raw and is range-checked by those precompiles; pA1.y is the one
                // value consumed only via the inline modular negation.
                if iszero(lt(calldataload(add(pA1, 32)), q_mod)) { leave }

                // 2. Fiat-Shamir challenge with domain separation
                //    Memory layout (all offsets from `base`):
                //      [0..cdLen)         calldata for hashing
                //      [cdLen..cdLen+64)  address + chainid
                //      [cdLen+128..)      L₁(64) L₂(64) tmp(64) Lcomb(64) Ccomb(64) rA2(64) Acomb(64) pairing(960)
                let base := mload(0x40)
                let cdLen := sub(calldatasize(), 0x04)
                calldatacopy(base, 0x04, cdLen)
                mstore(add(base, cdLen), address())
                mstore(add(base, add(cdLen, 32)), chainid())
                let challenge := mod(keccak256(base, add(cdLen, 64)), r_mod)
                if iszero(challenge) { challenge := 1 }

                // Points area starts after hash input + 128 byte gap
                let p := add(base, add(cdLen, 128))
                // p+0:   L₁ (64 bytes)
                // p+64:  L₂ (64 bytes)
                // p+128: tmp (64 bytes, reusable scratch)
                // p+192: L_combined (64 bytes)
                // p+256: C_combined (64 bytes)
                // p+320: r·A₂ (64 bytes)
                // p+384: α_combined (64 bytes)
                // p+448: pairing input (960 bytes)
                // Total: 1408 bytes from p
                mstore(0x40, add(p, 1408))

                // 3. Compute L₁ = IC[0] + Σ pub1[i] · IC[i+1]
                mstore(p, IC0x)
                mstore(add(p, 32), IC0y)
                if iszero(g1_mulAccC(p, IC1x, IC1y, calldataload(add(pub1, 0)))) { leave }
                if iszero(g1_mulAccC(p, IC2x, IC2y, calldataload(add(pub1, 32)))) { leave }
                if iszero(g1_mulAccC(p, IC3x, IC3y, calldataload(add(pub1, 64)))) { leave }
                if iszero(g1_mulAccC(p, IC4x, IC4y, calldataload(add(pub1, 96)))) { leave }
                if iszero(g1_mulAccC(p, IC5x, IC5y, calldataload(add(pub1, 128)))) { leave }
                if iszero(g1_mulAccC(p, IC6x, IC6y, calldataload(add(pub1, 160)))) { leave }
                if iszero(g1_mulAccC(p, IC7x, IC7y, calldataload(add(pub1, 192)))) { leave }
                if iszero(g1_mulAccC(p, IC8x, IC8y, calldataload(add(pub1, 224)))) { leave }
                if iszero(g1_mulAccC(p, IC9x, IC9y, calldataload(add(pub1, 256)))) { leave }
                if iszero(g1_mulAccC(p, IC10x, IC10y, calldataload(add(pub1, 288)))) { leave }
                if iszero(g1_mulAccC(p, IC11x, IC11y, calldataload(add(pub1, 320)))) { leave }
                if iszero(g1_mulAccC(p, IC12x, IC12y, calldataload(add(pub1, 352)))) { leave }
                if iszero(g1_mulAccC(p, IC13x, IC13y, calldataload(add(pub1, 384)))) { leave }
                if iszero(g1_mulAccC(p, IC14x, IC14y, calldataload(add(pub1, 416)))) { leave }
                if iszero(g1_mulAccC(p, IC15x, IC15y, calldataload(add(pub1, 448)))) { leave }

                // 4. Compute L₂ at p+64
                let pL2 := add(p, 64)
                mstore(pL2, IC0x)
                mstore(add(pL2, 32), IC0y)
                if iszero(g1_mulAccC(pL2, IC1x, IC1y, calldataload(add(pub2, 0)))) { leave }
                if iszero(g1_mulAccC(pL2, IC2x, IC2y, calldataload(add(pub2, 32)))) { leave }
                if iszero(g1_mulAccC(pL2, IC3x, IC3y, calldataload(add(pub2, 64)))) { leave }
                if iszero(g1_mulAccC(pL2, IC4x, IC4y, calldataload(add(pub2, 96)))) { leave }
                if iszero(g1_mulAccC(pL2, IC5x, IC5y, calldataload(add(pub2, 128)))) { leave }
                if iszero(g1_mulAccC(pL2, IC6x, IC6y, calldataload(add(pub2, 160)))) { leave }
                if iszero(g1_mulAccC(pL2, IC7x, IC7y, calldataload(add(pub2, 192)))) { leave }
                if iszero(g1_mulAccC(pL2, IC8x, IC8y, calldataload(add(pub2, 224)))) { leave }
                if iszero(g1_mulAccC(pL2, IC9x, IC9y, calldataload(add(pub2, 256)))) { leave }
                if iszero(g1_mulAccC(pL2, IC10x, IC10y, calldataload(add(pub2, 288)))) { leave }
                if iszero(g1_mulAccC(pL2, IC11x, IC11y, calldataload(add(pub2, 320)))) { leave }
                if iszero(g1_mulAccC(pL2, IC12x, IC12y, calldataload(add(pub2, 352)))) { leave }
                if iszero(g1_mulAccC(pL2, IC13x, IC13y, calldataload(add(pub2, 384)))) { leave }
                if iszero(g1_mulAccC(pL2, IC14x, IC14y, calldataload(add(pub2, 416)))) { leave }
                if iszero(g1_mulAccC(pL2, IC15x, IC15y, calldataload(add(pub2, 448)))) { leave }

                // 5. Compute combined points using fixed offsets from p
                //    tmp=p+128, Lc=p+192, Cc=p+256, rA2=p+320, Ac=p+384, pairing=p+448

                // L_combined = L₁ + r·L₂  →  tmp = r·L₂, then Lc = L₁ + tmp
                if iszero(g1_mul(add(p, 128), mload(pL2), mload(add(pL2, 32)), challenge)) { leave }
                if iszero(g1_add(add(p, 192), mload(p), mload(add(p, 32)), mload(add(p, 128)), mload(add(p, 160)))) {
                    leave
                }

                // C_combined = C₁ + r·C₂  →  tmp = r·C₂, then Cc = C₁ + tmp
                if iszero(g1_mul(add(p, 128), calldataload(pC2), calldataload(add(pC2, 32)), challenge)) {
                    leave
                }
                if iszero(
                    g1_add(
                        add(p, 256),
                        calldataload(pC1),
                        calldataload(add(pC1, 32)),
                        mload(add(p, 128)),
                        mload(add(p, 160))
                    )
                ) { leave }

                // r·A₂ at p+320
                if iszero(g1_mul(add(p, 320), calldataload(pA2), calldataload(add(pA2, 32)), challenge)) {
                    leave
                }

                // α_combined = (1+r)·α — single ecMul instead of ecMul + ecAdd
                if iszero(g1_mul(add(p, 384), alphax, alphay, addmod(1, challenge, r_mod))) { leave }

                // 6. Build 5-pair pairing input at p+448
                let pP := add(p, 448)

                // Pair 1: e(-A₁, B₁)
                mstore(pP, calldataload(pA1))
                mstore(add(pP, 32), mod(sub(q_mod, calldataload(add(pA1, 32))), q_mod))
                mstore(add(pP, 64), calldataload(pB1))
                mstore(add(pP, 96), calldataload(add(pB1, 32)))
                mstore(add(pP, 128), calldataload(add(pB1, 64)))
                mstore(add(pP, 160), calldataload(add(pB1, 96)))

                // Pair 2: e(-r·A₂, B₂)
                mstore(add(pP, 192), mload(add(p, 320)))
                mstore(add(pP, 224), mod(sub(q_mod, mload(add(p, 352))), q_mod))
                mstore(add(pP, 256), calldataload(pB2))
                mstore(add(pP, 288), calldataload(add(pB2, 32)))
                mstore(add(pP, 320), calldataload(add(pB2, 64)))
                mstore(add(pP, 352), calldataload(add(pB2, 96)))

                // Pair 3: e(L_combined, γ)
                mstore(add(pP, 384), mload(add(p, 192)))
                mstore(add(pP, 416), mload(add(p, 224)))
                mstore(add(pP, 448), gammax1)
                mstore(add(pP, 480), gammax2)
                mstore(add(pP, 512), gammay1)
                mstore(add(pP, 544), gammay2)

                // Pair 4: e(C_combined, δ)
                mstore(add(pP, 576), mload(add(p, 256)))
                mstore(add(pP, 608), mload(add(p, 288)))
                mstore(add(pP, 640), deltax1)
                mstore(add(pP, 672), deltax2)
                mstore(add(pP, 704), deltay1)
                mstore(add(pP, 736), deltay2)

                // Pair 5: e(α_combined, β)
                mstore(add(pP, 768), mload(add(p, 384)))
                mstore(add(pP, 800), mload(add(p, 416)))
                mstore(add(pP, 832), betax1)
                mstore(add(pP, 864), betax2)
                mstore(add(pP, 896), betay1)
                mstore(add(pP, 928), betay2)

                // 7. ecPairing precompile (5 pairs × 192 = 960 bytes)
                let success := staticcall(sub(gas(), 2000), 8, pP, 960, pP, 0x20)
                isOk := and(success, mload(pP))
            }

            result := doBatchVerify(_pA1, _pB1, _pC1, _pubSignals1, _pA2, _pB2, _pC2, _pubSignals2)
        }
    }
}
