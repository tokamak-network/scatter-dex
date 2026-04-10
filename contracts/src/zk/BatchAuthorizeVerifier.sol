// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {IBatchAuthorizeVerifier} from "./IBatchAuthorizeVerifier.sol";

/// @title BatchAuthorizeVerifier
/// @notice Phase 1 scaffold for batched Groth16 verification of two authorize.circom proofs.
///         Currently verifies each proof separately (no gas savings yet).
///         Phase 2 will implement random linear combination (Fiat-Shamir) to reduce
///         from 8 pairings (2×4) to 5 pairings, saving ~24% gas (~145K per settleAuth).
///
/// @dev Phase 2 batch verification equation:
///
///   r = keccak256(A₁, B₁, C₁, pub₁, A₂, B₂, C₂, pub₂, address(this), block.chainid) mod r
///   e(-A₁, B₁) · e(-r·A₂, B₂) · e(L₁ + r·L₂, γ) · e(C₁ + r·C₂, δ) · e((1+r)·α, β) = 1
///
///   Soundness error: 1/r ≈ 2^{-254} (negligible).
///
///   This contract uses the same verification key as AuthorizeVerifier.sol (same circuit,
///   same trusted setup). The vkey constants are duplicated here rather than read from
///   storage to keep everything in assembly for gas efficiency.
///   WARNING: If the circuit is recompiled, both AuthorizeVerifier.sol and this file
///   must be regenerated/updated in lock-step.
contract BatchAuthorizeVerifier is IBatchAuthorizeVerifier {
    // Scalar field size (BN254)
    uint256 constant r_mod = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size (BN254)
    uint256 constant q_mod = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // ── Verification key (same as AuthorizeVerifier.sol) ──
    uint256 constant alphax  = 21453198727776139087419428906065808286606573647564108419292103698640906223874;
    uint256 constant alphay  = 9404247001616600853624244252485898872814751337440908970900751097733868970098;
    uint256 constant betax1  = 2208984256590118630672582863085767610004799064917767429529783766243203025344;
    uint256 constant betax2  = 20323700906424095472436200797492622482455341492593966954135533974627232300713;
    uint256 constant betay1  = 20760881093510484537819091280510574545303343217265593116177516601254560196315;
    uint256 constant betay2  = 11980669709104506570842928532354039763608217517855903714675589871315059359442;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 19460186110182385302741511281984018247391441170218126794295312507785849445860;
    uint256 constant deltax2 = 20967971047135910181128047411967155832689471618676798585731421083358606308137;
    uint256 constant deltay1 = 5735415869858054566702521615143405585042505501009114832556037406919649731190;
    uint256 constant deltay2 = 7492531522330134479868886347602541486790195993607027377608688616543196490953;

    // IC points (14 public inputs + IC[0]) — copied verbatim from AuthorizeVerifier.sol
    uint256 constant IC0x = 18151507194099939518705384504310870905284772141252040818055901637800621903587;
    uint256 constant IC0y = 1536022071370712318639304415787279949452050924555522930208829930944431976682;
    uint256 constant IC1x = 17593614595072747856967544519964652233131361771279150603699573280113232656106;
    uint256 constant IC1y = 4169995828970602555221762031584337135973120043860117275417428170288842732241;
    uint256 constant IC2x = 5615972752869691046434196793526133356625769809876570743080982363341245583350;
    uint256 constant IC2y = 7083179365271048257970870210778969969262526324624321353592849776426913539397;
    uint256 constant IC3x = 9316973046283522108164432797209071983942074469491565887692778713697032295534;
    uint256 constant IC3y = 13888741309312190190101836357251274960533244338404136792381223475850708741853;
    uint256 constant IC4x = 5159206581658717230853678071688809276258195752694021185442903389204424013910;
    uint256 constant IC4y = 2101992593200218375629096130423274969935229300199587553212717225237686042512;
    uint256 constant IC5x = 10742094946825824951204544771765054051064752305687172182708226190312961273818;
    uint256 constant IC5y = 8050928034671087311872708530558529069792451599592938150486261415577126204235;
    uint256 constant IC6x = 12388080673323575757588043170070038453740812229573937803064384704161808081403;
    uint256 constant IC6y = 4722288151337083885733382671816356688753276053906876519897515754777870004574;
    uint256 constant IC7x = 16701988402855692921527383150401021426468349661370898041678485729764585379566;
    uint256 constant IC7y = 20476907541581330270619944272782293314175406442395714984933925293058058789081;
    uint256 constant IC8x = 7736772465267198287618583436588928530561395331401572134027834607847514709767;
    uint256 constant IC8y = 5726751882855707913723612462232186634612748122388892921007438215679130583527;
    uint256 constant IC9x = 15730908073713750553143115766879461892172858874991375517416709362447886970506;
    uint256 constant IC9y = 1693093340308108570945430743147187212951751884160476096078522921192312775486;
    uint256 constant IC10x = 19388105310741290242483917865574808571701783816368583242954805504028486002863;
    uint256 constant IC10y = 19708877133508775178493362093478243176957505187640893865001418470504865711355;
    uint256 constant IC11x = 11216875698262982622851106056023643016021157548989451567424493017175460802101;
    uint256 constant IC11y = 11427621860275307347713536177015665356171004230248443763246248447105663373865;
    uint256 constant IC12x = 20505188841043216455110790066911729832616190527121915093318488668699805200746;
    uint256 constant IC12y = 6943804917262328370627790875391563480705952204078351696060832689312718437730;
    uint256 constant IC13x = 12747608974320356135678704353699275189993477371848465567266503671464911952326;
    uint256 constant IC13y = 21372018527949030192984835514020116113593905599888109317418663858156864108011;
    uint256 constant IC14x = 15653016779368561696678677434590855505763465529083398324600681220711524398745;
    uint256 constant IC14y = 4951316924552111065974463525523253089397192817655190295699137776693752728060;

    /// @notice Batch-verify two Groth16 proofs from authorize.circom.
    /// @param _pA1 Proof 1 point A (G1)
    /// @param _pB1 Proof 1 point B (G2)
    /// @param _pC1 Proof 1 point C (G1)
    /// @param _pubSignals1 Proof 1 public signals (14 elements)
    /// @param _pA2 Proof 2 point A (G1)
    /// @param _pB2 Proof 2 point B (G2)
    /// @param _pC2 Proof 2 point C (G1)
    /// @param _pubSignals2 Proof 2 public signals (14 elements)
    /// @return True if both proofs are valid
    function verifyBatchProof(
        uint[2] calldata _pA1, uint[2][2] calldata _pB1, uint[2] calldata _pC1, uint[14] calldata _pubSignals1,
        uint[2] calldata _pA2, uint[2][2] calldata _pB2, uint[2] calldata _pC2, uint[14] calldata _pubSignals2
    ) public view returns (bool) {
        // Phase 1: Two separate verifications (correctness baseline).
        // Phase 2 will replace this with a single 5-pairing batch check:
        //   r = keccak256(A₁,B₁,C₁,pub₁,A₂,B₂,C₂,pub₂, address(this), block.chainid) mod scalar_field
        //   e(-A₁, B₁) · e(-r·A₂, B₂) · e(L₁+r·L₂, γ) · e(C₁+r·C₂, δ) · e((1+r)·α, β) = 1
        // Expected savings: ~145K gas (~24%) from 8 → 5 pairings.
        return _verifySingle(_pA1, _pB1, _pC1, _pubSignals1)
            && _verifySingle(_pA2, _pB2, _pC2, _pubSignals2);
    }

    /// @dev Single proof verification (same logic as AuthorizeVerifier).
    ///      IMPORTANT: Unlike the snarkjs-generated verifier, this function uses
    ///      `leave` instead of assembly `return(0, 0x20)` so it can be called as
    ///      an internal function without terminating the entire call frame.
    /// @dev Single proof verification (same logic as AuthorizeVerifier).
    ///      IMPORTANT: Unlike the snarkjs-generated verifier, this does NOT use
    ///      assembly `return(0, 0x20)` — that opcode terminates the entire call
    ///      frame, which would skip the second proof in verifyBatchProof.
    ///      Instead, the result is assigned to the Solidity return variable.
    function _verifySingle(
        uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[14] calldata _pubSignals
    ) internal view returns (bool result) {
        assembly {
            function doVerify(pA, pB, pC, pubSignals) -> isOk {
                isOk := 0  // default: invalid

                function g1_mulAccC(pR, x, y, s) -> ok {
                    ok := 1
                    let mIn := mload(0x40)
                    mstore(mIn, x)
                    mstore(add(mIn, 32), y)
                    mstore(add(mIn, 64), s)
                    let success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)
                    if iszero(success) { ok := 0 leave }
                    mstore(add(mIn, 64), mload(pR))
                    mstore(add(mIn, 96), mload(add(pR, 32)))
                    success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)
                    if iszero(success) { ok := 0 leave }
                }

                let pMem := mload(0x40)
                mstore(0x40, add(pMem, 896))

                // Validate all public signals ∈ F
                for { let i := 0 } lt(i, 14) { i := add(i, 1) } {
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
