// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettleVerifyLib} from "../src/zk/SettleVerifyLib.sol";

/// @dev Thin wrapper that owns a `whitelistedTokens` mapping and forwards
///      every external SettleVerifyLib entry point. Lets us exercise the
///      library's revert paths in isolation without standing up the full
///      PrivateSettlement / CommitmentPool stack.
contract SVLHarness {
    mapping(address => bool) public whitelistedTokens;

    function setWhitelist(address t, bool ok) external {
        whitelistedTokens[t] = ok;
    }

    function callValidateCrossSide(
        SettleVerifyLib.AuthorizeProof calldata maker,
        SettleVerifyLib.AuthorizeProof calldata taker,
        uint96 feeMaker,
        uint96 feeTaker
    ) external view {
        SettleVerifyLib.validateCrossSide(maker, taker, feeMaker, feeTaker, whitelistedTokens);
    }

    function callValidateDexProof(SettleVerifyLib.AuthorizeProof calldata proof, address sender, uint256 deadline)
        external
        view
    {
        SettleVerifyLib.validateDexProof(proof, sender, deadline, whitelistedTokens);
    }

    function callValidateScatterAuth(SettleVerifyLib.AuthorizeProof calldata ap, address sender, uint96 fee)
        external
        view
    {
        SettleVerifyLib.validateScatterAuth(ap, sender, fee, whitelistedTokens);
    }

    function callRequireDistinctClaimsRoots(bytes32 rootA, bytes32 rootB, uint128 lockedA, uint128 lockedB)
        external
        pure
    {
        SettleVerifyLib.requireDistinctClaimsRoots(rootA, rootB, lockedA, lockedB);
    }

    function callPackAuthSignals(SettleVerifyLib.AuthorizeProof calldata ap)
        external
        pure
        returns (uint256[15] memory)
    {
        return SettleVerifyLib.packAuthSignals(ap);
    }
}

/// @title SettleVerifyLibTest
/// @notice Direct revert-matrix coverage for every `external` entry point
///         on SettleVerifyLib. Mock-free, integration-free — the library
///         is pure-validation logic so each guard can be flipped on/off
///         independently by perturbing one struct field at a time.
contract SettleVerifyLibTest is Test {
    SVLHarness h;

    address constant TOKEN_A = address(0xAAAA);
    address constant TOKEN_B = address(0xBBBB);
    address constant TOKEN_C = address(0xCCCC); // unwhitelisted
    address constant RELAYER = address(0xBEEF);

    function setUp() public {
        h = new SVLHarness();
        h.setWhitelist(TOKEN_A, true);
        h.setWhitelist(TOKEN_B, true);
    }

    // ─── packAuthSignals (pure) ─────────────────────────────────

    function test_packAuthSignals_layout() public view {
        SettleVerifyLib.AuthorizeProof memory ap = _baseProof();
        ap.commitmentRoot = uint256(0xC0FFEE);
        uint256[15] memory sig = h.callPackAuthSignals(ap);
        // Layout (authorize.circom contract): pubKeyBind, commitmentRoot,
        // nullifier, nonceNullifier, newCommitment, sellToken, buyToken,
        // sellAmount, buyAmount, maxFee, expiry, claimsRoot, totalLocked,
        // relayer, orderHash.
        assertEq(sig[1], uint256(0xC0FFEE));
        assertEq(sig[7], uint256(ap.sellAmount));
        assertEq(sig[13], uint256(uint160(RELAYER)));
    }

    // ─── validateScatterAuth ────────────────────────────────────

    function test_scatterAuth_wrongRelayer_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        vm.expectRevert(SettleVerifyLib.NotMakerOrTakerRelayer.selector);
        h.callValidateScatterAuth(ap, address(0xDEAD), 0);
    }

    function test_scatterAuth_sellBuyTokenMismatch_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        ap.buyToken = TOKEN_B; // not same token
        vm.expectRevert(SettleVerifyLib.SellBuyTokenMismatch.selector);
        h.callValidateScatterAuth(ap, RELAYER, 0);
    }

    function test_scatterAuth_tokenNotWhitelisted_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        ap.sellToken = TOKEN_C;
        ap.buyToken = TOKEN_C;
        vm.expectRevert(SettleVerifyLib.TokenNotWhitelisted.selector);
        h.callValidateScatterAuth(ap, RELAYER, 0);
    }

    function test_scatterAuth_zeroSellAmount_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        ap.sellAmount = 0;
        vm.expectRevert(SettleVerifyLib.ZeroSellAmount.selector);
        h.callValidateScatterAuth(ap, RELAYER, 0);
    }

    function test_scatterAuth_zeroBuyAmount_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        ap.buyAmount = 0;
        vm.expectRevert(SettleVerifyLib.ZeroBuyAmount.selector);
        h.callValidateScatterAuth(ap, RELAYER, 0);
    }

    function test_scatterAuth_feeExceedsMax_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        ap.maxFee = 100; // 1%
        // fee=10 on sellAmount=1000 → 1% → ok. Bump fee to 11 → exceeds.
        vm.expectRevert(SettleVerifyLib.FeeExceedsMax.selector);
        h.callValidateScatterAuth(ap, RELAYER, 11);
    }

    function test_scatterAuth_claimsCapExceeded_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        ap.totalLocked = uint128(ap.sellAmount); // already eq → +fee pushes over
        vm.expectRevert(SettleVerifyLib.ClaimsCapExceeded.selector);
        h.callValidateScatterAuth(ap, RELAYER, 1);
    }

    function test_scatterAuth_expired_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        ap.expiry = uint64(block.timestamp - 1);
        vm.expectRevert(SettleVerifyLib.OrderExpired.selector);
        h.callValidateScatterAuth(ap, RELAYER, 0);
    }

    function test_scatterAuth_happyPath_passes() public view {
        SettleVerifyLib.AuthorizeProof memory ap = _baseScatter();
        h.callValidateScatterAuth(ap, RELAYER, 0);
    }

    // ─── validateDexProof ───────────────────────────────────────

    function test_dexProof_deadlineExpired_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        vm.expectRevert(SettleVerifyLib.DeadlineExpired.selector);
        h.callValidateDexProof(ap, RELAYER, block.timestamp - 1);
    }

    function test_dexProof_wrongRelayer_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        vm.expectRevert(SettleVerifyLib.NotMakerOrTakerRelayer.selector);
        h.callValidateDexProof(ap, address(0xDEAD), block.timestamp + 100);
    }

    function test_dexProof_sameTokenSides_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        ap.buyToken = ap.sellToken;
        vm.expectRevert(SettleVerifyLib.TokenSidesMismatch.selector);
        h.callValidateDexProof(ap, RELAYER, block.timestamp + 100);
    }

    function test_dexProof_sellTokenNotWhitelisted_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        ap.sellToken = TOKEN_C;
        vm.expectRevert(SettleVerifyLib.TokenNotWhitelisted.selector);
        h.callValidateDexProof(ap, RELAYER, block.timestamp + 100);
    }

    function test_dexProof_buyTokenNotWhitelisted_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        ap.buyToken = TOKEN_C;
        vm.expectRevert(SettleVerifyLib.TokenNotWhitelisted.selector);
        h.callValidateDexProof(ap, RELAYER, block.timestamp + 100);
    }

    function test_dexProof_zeroSellAmount_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        ap.sellAmount = 0;
        vm.expectRevert(SettleVerifyLib.ZeroSellAmount.selector);
        h.callValidateDexProof(ap, RELAYER, block.timestamp + 100);
    }

    function test_dexProof_expired_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        ap.expiry = uint64(block.timestamp - 1);
        vm.expectRevert(SettleVerifyLib.OrderExpired.selector);
        h.callValidateDexProof(ap, RELAYER, block.timestamp + 100);
    }

    function test_dexProof_nullifierCollision_reverts() public {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        ap.nullifier = bytes32(uint256(0x42));
        ap.nonceNullifier = bytes32(uint256(0x42));
        vm.expectRevert(SettleVerifyLib.NullifierAlreadySpent.selector);
        h.callValidateDexProof(ap, RELAYER, block.timestamp + 100);
    }

    function test_dexProof_happyPath_passes() public view {
        SettleVerifyLib.AuthorizeProof memory ap = _baseDex();
        h.callValidateDexProof(ap, RELAYER, block.timestamp + 100);
    }

    // ─── validateCrossSide (settleAuth) ─────────────────────────

    function test_crossSide_zeroSell_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        m.sellAmount = 0;
        vm.expectRevert(SettleVerifyLib.ZeroSellAmount.selector);
        h.callValidateCrossSide(m, t, 0, 0);
    }

    function test_crossSide_zeroBuy_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        t.buyAmount = 0;
        vm.expectRevert(SettleVerifyLib.ZeroBuyAmount.selector);
        h.callValidateCrossSide(m, t, 0, 0);
    }

    function test_crossSide_sellTokenNotWhitelisted_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        m.sellToken = TOKEN_C;
        vm.expectRevert(SettleVerifyLib.TokenNotWhitelisted.selector);
        h.callValidateCrossSide(m, t, 0, 0);
    }

    function test_crossSide_tokenSidesMismatch_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        t.buyToken = TOKEN_A; // maker.sellToken == taker.buyToken broken
        // Need to keep taker.sellToken whitelisted; tweak so maker.sellToken != taker.buyToken
        m.sellToken = TOKEN_B;
        t.buyToken = TOKEN_A;
        vm.expectRevert(SettleVerifyLib.TokenSidesMismatch.selector);
        h.callValidateCrossSide(m, t, 0, 0);
    }

    function test_crossSide_priceMismatch_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        // takerProduct > makerProduct → revert
        t.buyAmount = m.sellAmount + 1; // inflate beyond allowable ratio
        vm.expectRevert(SettleVerifyLib.PriceMismatch.selector);
        h.callValidateCrossSide(m, t, 0, 0);
    }

    function test_crossSide_claimsCapExceeded_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        m.totalLocked = uint128(t.sellAmount); // pushes maker.totalLocked + fee past taker.sellAmount
        vm.expectRevert(SettleVerifyLib.ClaimsCapExceeded.selector);
        h.callValidateCrossSide(m, t, 1, 0);
    }

    function test_crossSide_feeExceedsMax_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        m.maxFee = 100; // 1%
        // feeMaker=11 on buyAmount=1000 → exceeds the 1% cap
        vm.expectRevert(SettleVerifyLib.FeeExceedsMax.selector);
        h.callValidateCrossSide(m, t, 11, 0);
    }

    function test_crossSide_expired_reverts() public {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        t.expiry = uint64(block.timestamp - 1);
        vm.expectRevert(SettleVerifyLib.OrderExpired.selector);
        h.callValidateCrossSide(m, t, 0, 0);
    }

    function test_crossSide_happyPath_passes() public view {
        (SettleVerifyLib.AuthorizeProof memory m, SettleVerifyLib.AuthorizeProof memory t) = _crossPair();
        h.callValidateCrossSide(m, t, 0, 0);
    }

    // ─── requireDistinctClaimsRoots ─────────────────────────────

    function test_distinctClaimsRoots_duplicate_reverts() public {
        vm.expectRevert(SettleVerifyLib.DuplicateClaimsRoot.selector);
        h.callRequireDistinctClaimsRoots(bytes32(uint256(1)), bytes32(uint256(1)), 1, 1);
    }

    function test_distinctClaimsRoots_oneSidedZero_passes() public view {
        // Same root but one side has zero locked → permitted (one-sided settle).
        h.callRequireDistinctClaimsRoots(bytes32(uint256(1)), bytes32(uint256(1)), 0, 1);
        h.callRequireDistinctClaimsRoots(bytes32(uint256(1)), bytes32(uint256(1)), 1, 0);
    }

    function test_distinctClaimsRoots_differentRoots_passes() public view {
        h.callRequireDistinctClaimsRoots(bytes32(uint256(1)), bytes32(uint256(2)), 1, 1);
    }

    // ─── helpers ────────────────────────────────────────────────

    function _baseProof() internal view returns (SettleVerifyLib.AuthorizeProof memory ap) {
        ap.proofA = [uint256(0), uint256(0)];
        ap.proofB = [[uint256(0), uint256(0)], [uint256(0), uint256(0)]];
        ap.proofC = [uint256(0), uint256(0)];
        ap.pubKeyBind = bytes32(uint256(0xAB));
        ap.commitmentRoot = uint256(0xCD);
        ap.nullifier = bytes32(uint256(0xEF));
        ap.nonceNullifier = bytes32(uint256(0xF0));
        ap.newCommitment = bytes32(uint256(0xF1));
        ap.sellAmount = 1000;
        ap.buyAmount = 1000;
        ap.maxFee = 10_000; // 100% — turn off fee cap for non-fee tests
        ap.expiry = uint64(block.timestamp + 3600);
        ap.claimsRoot = bytes32(uint256(0xF2));
        ap.totalLocked = 500;
        ap.relayer = RELAYER;
        ap.orderHash = bytes32(uint256(0xF3));
        ap.tier = 16;
    }

    function _baseScatter() internal view returns (SettleVerifyLib.AuthorizeProof memory ap) {
        ap = _baseProof();
        ap.sellToken = TOKEN_A;
        ap.buyToken = TOKEN_A; // same-token invariant for scatter
    }

    function _baseDex() internal view returns (SettleVerifyLib.AuthorizeProof memory ap) {
        ap = _baseProof();
        ap.sellToken = TOKEN_A;
        ap.buyToken = TOKEN_B; // different tokens for DEX swap
    }

    function _crossPair()
        internal
        view
        returns (SettleVerifyLib.AuthorizeProof memory maker, SettleVerifyLib.AuthorizeProof memory taker)
    {
        maker = _baseProof();
        maker.sellToken = TOKEN_A;
        maker.buyToken = TOKEN_B;

        taker = _baseProof();
        taker.sellToken = TOKEN_B;
        taker.buyToken = TOKEN_A;
    }
}
