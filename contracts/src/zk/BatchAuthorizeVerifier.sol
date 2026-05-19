// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {IBatchAuthorizeVerifier} from "./IBatchAuthorizeVerifier.sol";

/// @title BatchAuthorizeVerifier
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
///   WARNING: If the circuit is recompiled, both AuthorizeVerifier.sol and this file
///   must be regenerated/updated in lock-step.
contract BatchAuthorizeVerifier is IBatchAuthorizeVerifier {
    // Scalar field size (BN254)
    uint256 constant r_mod = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size (BN254)
    uint256 constant q_mod = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // ── Verification key (same as AuthorizeVerifier.sol) ──
    uint256 constant alphax  = 14384235950119042070567818654293029140252137645950092982200714679054372372256;
    uint256 constant alphay  = 14075923080327348721385669700616374867289808503732072523040648403250897957648;
    uint256 constant betax1  = 1618103450510739521020245476891711802836810401088853005485593396117986383843;
    uint256 constant betax2  = 21655532960701529153129077519508441025297202035621250212899765885768489397519;
    uint256 constant betay1  = 4723287139694702391024121862840241728712425624069410330204922501305415335416;
    uint256 constant betay2  = 1313449656396141369532788943395729775208866318295459447514040949756582166527;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 15701008673681608240610964197433785919575532317160431444405787383582744302368;
    uint256 constant deltax2 = 3868536275328828774463313630967930289475144707733131547973397579749763279632;
    uint256 constant deltay1 = 11500108964867210111944385035186807935256984759528156275472048391541145189211;
    uint256 constant deltay2 = 21008901696631490207570388095231878367720121228439053990424051177278926685063;

    // IC points (15 public signals + IC[0]) — copied verbatim from AuthorizeVerifier.sol
    uint256 constant IC0x = 17271318639758365988751047333980533436866891281854542627574538932935889651639;
    uint256 constant IC0y = 455930527351187065562187941098393262911498377877555145311893819759239536211;
    uint256 constant IC1x = 2478090436571704305990343419565845231776817556799341820237966659560455991999;
    uint256 constant IC1y = 558242583547285323663332925080586355680112071411136725110526546805849047757;
    uint256 constant IC2x = 21854619097328675295301671076848093304394804010274957679457223977207681269498;
    uint256 constant IC2y = 5117076589834480120279608590177848737415393490555210200943494056612082853334;
    uint256 constant IC3x = 12723212527701216587930787385573535724307636606237521335161021938818085972068;
    uint256 constant IC3y = 4643673429825920963063046800356224262078202048315124528241517901278402884759;
    uint256 constant IC4x = 3563628086599279385131913637486302735117863672034648978934369549287193498904;
    uint256 constant IC4y = 21516696166019681742377774419221782297776744830825923309485554914736772139380;
    uint256 constant IC5x = 21455330800675831128236277146298574887141391389151150911683984544921186981918;
    uint256 constant IC5y = 5570092102336085329274180440753939763027914063716445604118121181490513381225;
    uint256 constant IC6x = 13178819076808048066179232899490501664913954669523286905420309981489045793066;
    uint256 constant IC6y = 5996014969614642340470531787886933513961357441258066972040103552662601597021;
    uint256 constant IC7x = 20658998451800980680449313588387221347456773207385064313128359413092630678072;
    uint256 constant IC7y = 15015335781961129643047331440539200390716835592791191544922506808643819604825;
    uint256 constant IC8x = 20648750654329206608488535021391115217605754530118745230192955170391674542083;
    uint256 constant IC8y = 12942403275458414073969684884299376415418808506395495863917713425763749243435;
    uint256 constant IC9x = 5955654604670641596412435228462233195593728228495546488277556108651704447726;
    uint256 constant IC9y = 17182492196012891578175710682555851692822677357813135698796598278566689506860;
    uint256 constant IC10x = 4098551603435806625929733597208526884622727398357774812298937468262162815661;
    uint256 constant IC10y = 9587350036510458606680649179402686986542916643742259281780930172618077668323;
    uint256 constant IC11x = 16648425024521535569450420288920279587837501810719116060267848031699377188891;
    uint256 constant IC11y = 9271295906151557848377947278594136327063701577645101792347815255510700631667;
    uint256 constant IC12x = 11762317654452799094875061009465463787596436116132780585265031268567455726930;
    uint256 constant IC12y = 6916194015891621945222606665234448845138994694563556763402756021556560100000;
    uint256 constant IC13x = 451119204183274792021357319331953533258169060998407629782113047343615884255;
    uint256 constant IC13y = 12926993795781318782413110537196419362596746198160738061297304963936209487256;
    uint256 constant IC14x = 15606866427873846119223703605689211938676099115096699964802008460778136545867;
    uint256 constant IC14y = 1059908513637918196571928572902143127331032215105005172439623704128311847137;
    uint256 constant IC15x = 3248919567500033832463102099253660655498565859394685343983030889302807437356;
    uint256 constant IC15y = 17133784651431266235152144641943458063199513208393110083700416326054664539259;

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
        uint[2] calldata _pA1, uint[2][2] calldata _pB1, uint[2] calldata _pC1, uint[15] calldata _pubSignals1,
        uint[2] calldata _pA2, uint[2][2] calldata _pB2, uint[2] calldata _pC2, uint[15] calldata _pubSignals2
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
                if iszero(success) { ok := 0 leave }
                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))
                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)
                if iszero(success) { ok := 0 leave }
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
                if iszero(g1_add(add(p, 192), mload(p), mload(add(p, 32)), mload(add(p, 128)), mload(add(p, 160)))) { leave }

                // C_combined = C₁ + r·C₂  →  tmp = r·C₂, then Cc = C₁ + tmp
                if iszero(g1_mul(add(p, 128), calldataload(pC2), calldataload(add(pC2, 32)), challenge)) { leave }
                if iszero(g1_add(add(p, 256), calldataload(pC1), calldataload(add(pC1, 32)), mload(add(p, 128)), mload(add(p, 160)))) { leave }

                // r·A₂ at p+320
                if iszero(g1_mul(add(p, 320), calldataload(pA2), calldataload(add(pA2, 32)), challenge)) { leave }

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
        uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[15] calldata _pubSignals
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
