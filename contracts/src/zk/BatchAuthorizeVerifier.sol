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
    uint256 constant alphax  = 15135396156234413853087359787606044402442741996044334255550260479750974595852;
    uint256 constant alphay  = 7657180127102157478996642197979756844402457931223247124413635395536717692152;
    uint256 constant betax1  = 21377720555205779053956549839639910235117370895859442003662098738624763211618;
    uint256 constant betax2  = 4552736268869375061155433204481913281924902903697607487565041451597220670754;
    uint256 constant betay1  = 15107258968230116396076038089679313377338151281230719179968083229104348369143;
    uint256 constant betay2  = 16270887921801704203765858713680297331602713401384553202643249205202073187800;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 2660037941353679577369004807337569137434201510305111767226477838193660657608;
    uint256 constant deltax2 = 7800819532100787066583109313963874846060707730233571559192467458995946755944;
    uint256 constant deltay1 = 20502040449951275947720647611675716978246635326360766668174976622372219747399;
    uint256 constant deltay2 = 10724511397734057742624873104029033256329069387493782222896694424570405808679;

    // IC points (15 public signals + IC[0]) — copied verbatim from AuthorizeVerifier.sol
    uint256 constant IC0x = 718334906764624747462754111340247384251388404545917380125803649791429730461;
    uint256 constant IC0y = 1087210564337950059402785310399383056816820973533456941321299816284439046637;
    uint256 constant IC1x = 16224878057452018671190301757818988624776232082068839380393689273476327345549;
    uint256 constant IC1y = 7530209022845262411697665180968707036190408175955322985563229677522802023840;
    uint256 constant IC2x = 15904448894965117011370418998915753378510048427265503254533992743910456443443;
    uint256 constant IC2y = 12166277308827408297801632540449619662100984613330964905071607399042951504149;
    uint256 constant IC3x = 21122532962328378487524886928802532386577829024462714356837869466927849990557;
    uint256 constant IC3y = 1453352420273477622903077308320760811049895273677550354778083945160490109066;
    uint256 constant IC4x = 11603075797223699915448104379646262584323186906735081818243538655426533941313;
    uint256 constant IC4y = 3247283071382629703491968795981063311419927012159391108635240664336450946748;
    uint256 constant IC5x = 6381941293189766108765947540304827913971116213990061173160301553505653888151;
    uint256 constant IC5y = 15454872629769503543120754073146382266381223310636197225168113547174446218983;
    uint256 constant IC6x = 21590430192271025742539913214890089639491468694536833407340911167830917448990;
    uint256 constant IC6y = 280717691268333013269121452243528331736039434377833309189710306069255971524;
    uint256 constant IC7x = 6345077924358056425757527035734306371293049906649879210745820737264015646269;
    uint256 constant IC7y = 3133383233583632788819734760418596739564648534330590332585765593711681565010;
    uint256 constant IC8x = 149360234158320439526636164995441516326074556588706643420078376203715776671;
    uint256 constant IC8y = 15411452357168863810165414376075196491077773075256273405495369868083032465292;
    uint256 constant IC9x = 7083649060747040206756222048112090379043304694688471506195473583414456814200;
    uint256 constant IC9y = 12164244493280055160586126510824233249054160781482079346210250658411643910647;
    uint256 constant IC10x = 2251404143411412531589930212999231201547654923954190522446758085756708934553;
    uint256 constant IC10y = 6636836915287775767641643564241820753870248758883986544014558502201030796439;
    uint256 constant IC11x = 21587728787099585776804922849555210053820474170733372750165446055501135789893;
    uint256 constant IC11y = 22055446236807448747380372528910884145206630230504689383963118562259628139;
    uint256 constant IC12x = 7368261072403535411999863614060269098404697470498438631939223667866988553078;
    uint256 constant IC12y = 3645116971182512669370254348318467629343911553514882671180041207793722790869;
    uint256 constant IC13x = 19771917007217381546894488055805960305495017167628043745834346292762452824342;
    uint256 constant IC13y = 10010790523997587296112517371156699657436352352122003087130106579581872982302;
    uint256 constant IC14x = 21384150893860594560454421855766652040417764974809772094687494701130898203543;
    uint256 constant IC14y = 17565832160035170038175265243085495532725421343791054628373426636650565939691;
    uint256 constant IC15x = 20856163744654418749601829502918193818249081397459664395196749757713423349027;
    uint256 constant IC15y = 17633162840295145613002271022861539222772843042533067661166770019653839168148;

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
