// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {IBatchAuthorizeVerifier} from "./IBatchAuthorizeVerifier.sol";

/// @title BatchAuthorizeVerifier64
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
///   This contract uses the same verification key as AuthorizeVerifier.sol (same circuit,
///   same trusted setup). The vkey constants are duplicated here rather than read from
///   storage to keep everything in assembly for gas efficiency.
///   WARNING: If the circuit is recompiled, both AuthorizeVerifier_64.sol and this file
///   must be regenerated/updated in lock-step.
contract BatchAuthorizeVerifier64 is IBatchAuthorizeVerifier {
    // Scalar field size (BN254)
    uint256 constant r_mod = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size (BN254)
    uint256 constant q_mod = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // ── Verification key (same as AuthorizeVerifier_64.sol (tier 64)) ──
    uint256 constant alphax = 21453198727776139087419428906065808286606573647564108419292103698640906223874;
    uint256 constant alphay = 9404247001616600853624244252485898872814751337440908970900751097733868970098;
    uint256 constant betax1 = 2208984256590118630672582863085767610004799064917767429529783766243203025344;
    uint256 constant betax2 = 20323700906424095472436200797492622482455341492593966954135533974627232300713;
    uint256 constant betay1 = 20760881093510484537819091280510574545303343217265593116177516601254560196315;
    uint256 constant betay2 = 11980669709104506570842928532354039763608217517855903714675589871315059359442;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 1305007833385833555609808451579317393017361876205047105564437604128134250298;
    uint256 constant deltax2 = 15794870400985512122507310563288459812952077918537125633638726222228814927331;
    uint256 constant deltay1 = 11992256252498354470303216403246096522979351322835143824775365278814137152078;
    uint256 constant deltay2 = 7027128042143751431506205512357257683534455631806855188964725742657545954205;

    // IC points (15 public signals + IC[0]) — copied verbatim from AuthorizeVerifier_64.sol
    uint256 constant IC0x = 3257507140472256991831661503515778160820197399714918259224972375649157462169;
    uint256 constant IC0y = 16635585648513229943665599891241317243665415663341736816643967582127994405763;
    uint256 constant IC1x = 2903562947036458932976119832199265137895400539393039310600678296961591417401;
    uint256 constant IC1y = 7594269171037128123331502459765705753010787968590715770300780285785903609939;
    uint256 constant IC2x = 13293717943872083291981352690392420858794036105824151204476655027273770704629;
    uint256 constant IC2y = 13232645160467905416004219654639685443317135546671236036335912778092461929087;
    uint256 constant IC3x = 20779059185767072943732031834249723684288599150202582621284864211608879245128;
    uint256 constant IC3y = 17659923080367108686087642018725789753498678191240753669649965428924979044116;
    uint256 constant IC4x = 8603084493225044587722022804288762192843626828616763193595006293634352781250;
    uint256 constant IC4y = 8334350139394979509224842410161550179722317095395434877949472879736859820086;
    uint256 constant IC5x = 3833903093136876378762334457857576526706359930380627878473981625074381675984;
    uint256 constant IC5y = 3759006276077526796442329441625342891661996390696699327135767038233386026784;
    uint256 constant IC6x = 17549482768476142260702768110875410986430378777053056805002803668392678293970;
    uint256 constant IC6y = 1670679306578174925438066267184191343726996649896340622585336752346876193050;
    uint256 constant IC7x = 17284696447593954646328510711005932463797814851537952984479143140323858076128;
    uint256 constant IC7y = 16746942905411137548032714460374622312297028598647390347248990773691729738691;
    uint256 constant IC8x = 14586981843816390796918724396453259021919449197270549916335545170789717399654;
    uint256 constant IC8y = 162493610637061455831415627640196979873919555844224318516257607565738865075;
    uint256 constant IC9x = 7927915551086976278489636545235928018453019494049445944107080421476258649543;
    uint256 constant IC9y = 1411296680172421879687665381897654062540845135110213175109693254540033982222;
    uint256 constant IC10x = 13067334946099710188460959283861716987524057157129939993616374498322813720852;
    uint256 constant IC10y = 18950706324730246352921175322386362766197413976045035081200463129725732009335;
    uint256 constant IC11x = 2697064337613415024998253919872167424966973946651606994346170539386397584458;
    uint256 constant IC11y = 16664109980851805090947605892610701282423675034574080032782760227788011348076;
    uint256 constant IC12x = 16628966632951934740386973284323691050786274983007408581764261671061840951934;
    uint256 constant IC12y = 9693262727065551432417259883332122786903104870169249359280851557517880236289;
    uint256 constant IC13x = 13455353024951120238290145590197856693189337262817226467403570704480580299609;
    uint256 constant IC13y = 10579767651469816328528854995378857602818420958128860765476256626387196083812;
    uint256 constant IC14x = 1311010880491928793005561245157956889473633920010034795355487569665379568554;
    uint256 constant IC14y = 2819038735137622409672823647504774862804258723429678062049533554704888828432;
    uint256 constant IC15x = 20313645874616648323871140482406968960305751673012964848509106785768236407929;
    uint256 constant IC15y = 11057596788146191780469653437170274352747967416727178309029544449191270484329;

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

    /// @dev Single proof verification (kept as fallback/testing, same logic as AuthorizeVerifier).
    ///      IMPORTANT: Unlike the snarkjs-generated verifier, this function uses
    ///      `leave` instead of assembly `return(0, 0x20)` so it can be called as
    ///      an internal function without terminating the entire call frame.
    /// @dev Single proof verification (same logic as AuthorizeVerifier).
    ///      IMPORTANT: Unlike the snarkjs-generated verifier, this does NOT use
    ///      assembly `return(0, 0x20)` — that opcode terminates the entire call
    ///      frame, which would skip the second proof in verifyBatchProof.
    ///      Instead, the result is assigned to the Solidity return variable.
    function _verifySingle(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[15] calldata _pubSignals
    ) internal view returns (bool result) {
        assembly {
            function doVerify(pA, pB, pC, pubSignals) -> isOk {
                isOk := 0 // default: invalid

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

                let pMem := mload(0x40)
                mstore(0x40, add(pMem, 896))

                // Validate all public signals ∈ F
                for { let i := 0 } lt(i, 15) { i := add(i, 1) } {
                    if iszero(lt(calldataload(add(pubSignals, mul(i, 32))), r_mod)) {
                        leave
                    }
                }

                // Compute vk_x = IC[0] + Σ pubSignals[i] · IC[i+1]
                let _pVk := pMem
                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                if iszero(g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))) { leave }
                if iszero(g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))) { leave }

                // Pairing check: e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1
                let _pPairing := add(pMem, 128)

                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q_mod, calldataload(add(pA, 32))), q_mod))
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)
                mstore(add(_pPairing, 384), mload(_pVk))
                mstore(add(_pPairing, 416), mload(add(_pVk, 32)))
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)

                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)
                isOk := and(success, mload(_pPairing))
            }

            result := doVerify(_pA, _pB, _pC, _pubSignals)
        }
    }
}
