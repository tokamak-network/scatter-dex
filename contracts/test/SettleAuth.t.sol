// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {SettleVerifyLib} from "../src/zk/SettleVerifyLib.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockBatchAuthorizeVerifier} from "./mocks/MockBatchAuthorizeVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract SAToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @title SettleAuthTest
/// @notice Tests for `PrivateSettlement.settleAuth` (Half-proof primitive).
///         Covers happy path, async-root invariant, the four cross-side checks
///         (token, price, claims+fees cap, fee bound), per-side checks
///         (expiry, root, nullifier), authorization, and relayer-registry
///         gating. The mock verifier accepts any proof unless explicitly
///         flipped via `setShouldPass(false)`.
contract SettleAuthTest is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    MockVerifier public withdrawVerifier;
    MockDepositVerifier public depositVerifier;
    MockClaimVerifier public claimVerifier;
    MockAuthorizeVerifier public authVerifier;
    MockWETH public weth;
    SAToken public usdc;

    address makerRelayer = address(0xBEEF1);
    address takerRelayer = address(0xBEEF2);

    // Dummy proof params
    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant M_NULL       = bytes32(uint256(0xa1));
    bytes32 constant M_NONCE_NULL = bytes32(uint256(0xa2));
    bytes32 constant M_NEW_COMMIT = bytes32(uint256(0xa3));
    bytes32 constant M_CLAIMS_R   = bytes32(uint256(0xa4));
    bytes32 constant M_ORDER_HASH = bytes32(uint256(0xa5));

    bytes32 constant T_NULL       = bytes32(uint256(0xb1));
    bytes32 constant T_NONCE_NULL = bytes32(uint256(0xb2));
    bytes32 constant T_NEW_COMMIT = bytes32(uint256(0xb3));
    bytes32 constant T_CLAIMS_R   = bytes32(uint256(0xb4));
    bytes32 constant T_ORDER_HASH = bytes32(uint256(0xb5));

    function setUp() public {
        withdrawVerifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        weth = new MockWETH();
        settlement = new PrivateSettlement(
            address(pool),
            address(claimVerifier),
            address(weth)
        );
        usdc = new SAToken("USDC", "USDC");

        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);
        pool.setAuthorizedSettlement(address(settlement));

        // Wire up the AuthorizeVerifier (this is the new bit for settleAuth)
        settlement.setAuthorizeVerifier(address(authVerifier));

        // Fund the pool so transferToSettlement and fee routing have something
        // to draw from. The default scenario sells 10 WETH for 20,000 USDC,
        // so we need at least that much of each token in the pool.
        vm.deal(address(this), 1100 ether);
        weth.deposit{value: 1100 ether}();
        weth.transfer(address(pool), 1000 ether);
        usdc.mint(address(pool), 1_000_000e18);
    }

    // ────────────────────────────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────────────────────────────

    /// @dev Build a default maker side: sells 10 WETH for >=20,000 USDC,
    ///      receives 20,000 USDC into the maker claims tree, no fee.
    function _defaultMaker() internal view returns (SettleVerifyLib.AuthorizeProof memory) {
        return SettleVerifyLib.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: bytes32(uint256(0xC1)),
            commitmentRoot: pool.getLastRoot(),
            nullifier: M_NULL,
            nonceNullifier: M_NONCE_NULL,
            newCommitment: M_NEW_COMMIT,
            sellToken: address(weth),
            buyToken: address(usdc),
            sellAmount: 10 ether,
            buyAmount: 20_000e18,
            maxFee: 100, // 1%
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: M_CLAIMS_R,
            totalLocked: uint128(20_000e18),
            relayer: makerRelayer,
            orderHash: M_ORDER_HASH
        });
    }

    /// @dev Build a default taker side that matches the default maker:
    ///      sells 20,000 USDC for >=10 WETH, receives 10 WETH, no fee.
    function _defaultTaker() internal view returns (SettleVerifyLib.AuthorizeProof memory) {
        return SettleVerifyLib.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: bytes32(uint256(0xC2)),
            commitmentRoot: pool.getLastRoot(),
            nullifier: T_NULL,
            nonceNullifier: T_NONCE_NULL,
            newCommitment: T_NEW_COMMIT,
            sellToken: address(usdc),
            buyToken: address(weth),
            sellAmount: 20_000e18,
            buyAmount: 10 ether,
            maxFee: 100, // 1%
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: T_CLAIMS_R,
            totalLocked: uint128(10 ether),
            relayer: takerRelayer,
            orderHash: T_ORDER_HASH
        });
    }

    function _defaultParams() internal view returns (PrivateSettlement.SettleAuthParams memory) {
        return PrivateSettlement.SettleAuthParams({
            maker: _defaultMaker(),
            taker: _defaultTaker(),
            feeTokenMaker: 0,
            feeTokenTaker: 0
        });
    }

    // ────────────────────────────────────────────────────────────
    //  Happy path
    // ────────────────────────────────────────────────────────────

    function test_settleAuth_happyPath_zeroFee() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();

        vm.prank(makerRelayer);
        settlement.settleAuth(p);

        // All four nullifiers marked
        assertTrue(settlement.nullifiers(M_NULL));
        assertTrue(settlement.nullifiers(T_NULL));
        assertTrue(settlement.nonceNullifiers(M_NONCE_NULL));
        assertTrue(settlement.nonceNullifiers(T_NONCE_NULL));

        // Maker claims group: token = USDC (maker.buyToken), locked = 20k USDC
        (uint128 ml,, address mt) = settlement.claimsGroups(M_CLAIMS_R);
        assertEq(mt, address(usdc));
        assertEq(ml, uint128(20_000e18));

        // Taker claims group: token = WETH (taker.buyToken), locked = 10 WETH
        (uint128 tl,, address tt) = settlement.claimsGroups(T_CLAIMS_R);
        assertEq(tt, address(weth));
        assertEq(tl, uint128(10 ether));
    }

    function test_settleAuth_happyPath_takerRelayerSubmits() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        vm.prank(takerRelayer);
        settlement.settleAuth(p);
        assertTrue(settlement.nullifiers(M_NULL));
    }

    function test_settleAuth_happyPath_withFees() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Cap under 2026-04-14 redesign: fee × 10000 ≤ ownBuyAmount × ownMaxFee.
        // Derive the at-the-cap value from the params so the test self-documents
        // and survives `_defaultParams` edits.
        uint96 feeMakerCap = uint96(uint256(p.maker.buyAmount) * p.maker.maxFee / 10000);
        uint96 feeTakerCap = uint96(uint256(p.taker.buyAmount) * p.taker.maxFee / 10000);
        p.feeTokenMaker = feeMakerCap;                   // paid by maker, in USDC
        p.feeTokenTaker = feeTakerCap;                   // paid by taker, in WETH
        p.maker.totalLocked = uint128(p.maker.buyAmount) - uint128(feeMakerCap);
        p.taker.totalLocked = uint128(p.taker.buyAmount) - uint128(feeTakerCap);

        uint256 makerRelayerUsdcBefore = usdc.balanceOf(makerRelayer);
        uint256 takerRelayerWethBefore = weth.balanceOf(takerRelayer);

        vm.prank(makerRelayer);
        settlement.settleAuth(p);

        // Fee for each side goes to the relayer holding that side's order.
        assertEq(usdc.balanceOf(makerRelayer) - makerRelayerUsdcBefore, feeMakerCap);
        assertEq(weth.balanceOf(takerRelayer) - takerRelayerWethBefore, feeTakerCap);
    }

    function test_settleAuth_happyPath_emitsEvent() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();

        vm.expectEmit(true, true, true, true);
        emit PrivateSettlement.PrivateSettledAuth(
            M_NULL,
            T_NULL,
            M_CLAIMS_R,
            T_CLAIMS_R,
            makerRelayer,
            takerRelayer,
            makerRelayer, // submitter
            0,
            0
        );

        vm.prank(makerRelayer);
        settlement.settleAuth(p);
    }

    // ────────────────────────────────────────────────────────────
    //  Zero-amount guards (S-M5)
    // ────────────────────────────────────────────────────────────

    function test_settleAuth_zeroBuyAmountMaker_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.maker.buyAmount = 0;

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.ZeroBuyAmount.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_zeroBuyAmountTaker_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.taker.buyAmount = 0;

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.ZeroBuyAmount.selector);
        settlement.settleAuth(p);
    }

    // ────────────────────────────────────────────────────────────
    //  Async-root invariant — the load-bearing PR #130 design change
    // ────────────────────────────────────────────────────────────

    function test_settleAuth_asyncRoot_differentRootsBothKnown_succeeds() public {
        // Insert a commitment so the pool's history has two roots:
        // the initial empty-tree root (set by IncrementalMerkleTree's
        // constructor) and the new root from this insert. setUp() does not
        // call pool.deposit() — the pool is funded by direct ERC20 transfers
        // — so prior to this insert the only root in history is the
        // empty-tree root.
        vm.prank(address(settlement));
        pool.insertCommitment(uint256(0xCAFE));

        uint256 latestRoot = pool.getLastRoot();
        // Walk one step back in the ring buffer
        uint32 prevIndex = (pool.currentRootIndex() + pool.ROOT_HISTORY_SIZE() - 1) % pool.ROOT_HISTORY_SIZE();
        uint256 prevRoot = pool.roots(prevIndex);
        // Sanity: they're different
        assertTrue(latestRoot != prevRoot);
        // Sanity: both are known
        assertTrue(pool.isKnownRoot(latestRoot));
        assertTrue(pool.isKnownRoot(prevRoot));

        // Maker uses the older root, taker uses the newer one — exactly the
        // case the async-matching design needs to support.
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.maker.commitmentRoot = prevRoot;
        p.taker.commitmentRoot = latestRoot;

        vm.prank(makerRelayer);
        settlement.settleAuth(p); // must NOT revert
        assertTrue(settlement.nullifiers(M_NULL));
    }

    function test_settleAuth_unknownMakerRoot_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.maker.commitmentRoot = uint256(0xDEAD);

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.UnknownRoot.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_unknownTakerRoot_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.taker.commitmentRoot = uint256(0xDEAD);

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.UnknownRoot.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_bothRootsStale_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.maker.commitmentRoot = uint256(0xDEAD);
        p.taker.commitmentRoot = uint256(0xBEEF);

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.UnknownRoot.selector);
        settlement.settleAuth(p);
    }

    // ────────────────────────────────────────────────────────────
    //  Cross-side checks
    // ────────────────────────────────────────────────────────────

    function test_settleAuth_tokenSidesMismatch_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Break the cross-side equality
        p.taker.buyToken = address(0xBADB);

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.TokenSidesMismatch.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_priceMismatch_reverts() public {
        // To trigger PriceMismatch in isolation, the test must arrange
        // inputs where the cap (step 5) trivially passes but the price
        // product still fails at step 4. We set totalLocked to 1 on
        // both sides so the cap check passes trivially.
        //
        // Note: a real authorize.circom proof would never carry
        // totalLocked=1 alongside a large buyAmount because the
        // in-circuit check `totalLocked >= buyAmount` would reject it.
        // The MockVerifier accepts any signal, which is what lets us
        // isolate the contract-level price check here.
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.maker.totalLocked = 1;
        p.taker.totalLocked = 1;

        // Maker: 10 sell, 18 buy (price = 1.8 buy/sell)
        // Taker: 17 sell, 10 buy (price = 1.7 sell/buy → maker doesn't get enough)
        p.maker.sellAmount = 10 ether;
        p.maker.buyAmount = uint128(18_000e18);
        p.taker.sellAmount = uint128(17_000e18);
        p.taker.buyAmount = 10 ether;
        // makerProduct = 10e18 * 17_000e18 = 1.7e41
        // takerProduct = 18_000e18 * 10e18 = 1.8e41
        // takerProduct > makerProduct → PriceMismatch

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.PriceMismatch.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_claimsCapExceeded_makerSide_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Set maker.totalLocked higher than taker.sellAmount
        p.maker.totalLocked = uint128(21_000e18);
        // Mint extra tokens so the test isn't blocked by InsufficientPoolBalance later
        usdc.mint(address(pool), 1_000e18);

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.ClaimsCapExceeded.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_claimsCapExceeded_takerSide_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Set taker.totalLocked higher than maker.sellAmount
        p.taker.totalLocked = uint128(11 ether);
        weth.transfer(address(pool), 1 ether);

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.ClaimsCapExceeded.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_feeExceedsMakerMaxFee_reverts() public {
        // The cap check (step 5) runs before the fee bound (step 6), so we
        // must leave room under the cap for the fee to be the failing check.
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // maker.maxFee = 100 bps, maker.sellAmount = 10 ether
        // max allowed feeTokenTaker = 10 ether * 100 / 10000 = 0.1 ether
        // Pick 0.2 ether (above the maxFee bound). The cap check requires
        // taker.totalLocked + feeTokenTaker ≤ maker.sellAmount = 10 ether,
        // so set taker.totalLocked low enough to leave room.
        p.taker.totalLocked = uint128(1 ether);
        p.feeTokenTaker = uint96(0.2 ether);
        // Cap check: 1 + 0.2 = 1.2 ≤ 10 ether ✓
        // Fee bound: 0.2 * 10000 = 2000 > 10 * 100 = 1000 → FeeExceedsMax ✓

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.FeeExceedsMax.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_feeExceedsTakerMaxFee_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // taker.maxFee = 100 bps, taker.sellAmount = 20_000e18
        // max allowed feeTokenMaker = 20_000e18 * 100 / 10000 = 200e18
        // Pick 300e18 (above the maxFee bound) and leave cap room.
        p.maker.totalLocked = uint128(1_000e18);
        p.feeTokenMaker = uint96(300e18);
        // Cap check: 1000 + 300 = 1300 ≤ 20_000e18 ✓
        // Fee bound: 300 * 10000 = 3_000_000 > 20_000 * 100 = 2_000_000 → FeeExceedsMax ✓

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.FeeExceedsMax.selector);
        settlement.settleAuth(p);
    }

    /// @notice Regression: a single-pair settlement that drains most of a
    ///         token's pool balance used to revert with `FeeExceedsMax`
    ///         from the old `CommitmentPool.transferFee` post-drain 10% cap.
    ///         The cap was removed, and the order-level `SettleVerifyLib`
    ///         fee bound is authoritative.
    function test_settleAuth_singlePairDrainsMostOfPool_succeeds() public {
        // Fresh pool with JUST ONE matched pair of liquidity — mirrors the
        // "1 WETH ↔ 2000 USDC, no other depositors" E2E scenario.
        CommitmentPool thinPool = new CommitmentPool(
            address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        thinPool.setTokenWhitelist(address(weth), true);
        thinPool.setTokenWhitelist(address(usdc), true);

        MockAuthorizeVerifier thinAuthVerifier = new MockAuthorizeVerifier();
        PrivateSettlement thinSettlement = new PrivateSettlement(
            address(thinPool), address(claimVerifier), address(weth)
        );
        thinSettlement.setTokenWhitelist(address(weth), true);
        thinSettlement.setTokenWhitelist(address(usdc), true);
        thinSettlement.setAuthorizeVerifier(address(thinAuthVerifier));
        thinPool.setAuthorizedSettlement(address(thinSettlement));

        // Fund exactly enough for one trade.
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 1 ether}();
        weth.transfer(address(thinPool), 1 ether);
        usdc.mint(address(thinPool), 2_000e18);

        // Build a pair where totalLocked takes 99.7% of each token and fee is
        // the remaining 0.3% — used to trip the old post-drain 10% cap.
        SettleVerifyLib.AuthorizeProof memory maker = _defaultMaker();
        SettleVerifyLib.AuthorizeProof memory taker = _defaultTaker();
        maker.commitmentRoot = thinPool.getLastRoot();
        taker.commitmentRoot = thinPool.getLastRoot();
        maker.sellAmount = uint128(2_000e18);  // 2000 USDC
        maker.buyAmount = uint128(1 ether);
        maker.sellToken = address(usdc);
        maker.buyToken = address(weth);
        maker.totalLocked = uint128(0.997 ether);
        taker.sellAmount = uint128(1 ether);
        taker.buyAmount = uint128(2_000e18);
        taker.sellToken = address(weth);
        taker.buyToken = address(usdc);
        taker.totalLocked = uint128(1_994e18);
        PrivateSettlement.SettleAuthParams memory p = PrivateSettlement.SettleAuthParams({
            maker: maker,
            taker: taker,
            feeTokenMaker: uint96(0.003 ether),  // 30 bps of 1 WETH
            feeTokenTaker: uint96(6e18)          // 30 bps of 2000 USDC
        });

        vm.prank(makerRelayer);
        thinSettlement.settleAuth(p);

        // Pool fully drained of both tokens; fees paid out cleanly.
        assertEq(IERC20(address(weth)).balanceOf(address(thinPool)), 0);
        assertEq(IERC20(address(usdc)).balanceOf(address(thinPool)), 0);
    }

    // ────────────────────────────────────────────────────────────
    //  Per-side checks
    // ────────────────────────────────────────────────────────────

    function test_settleAuth_makerExpired_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.maker.expiry = uint64(block.timestamp - 1);

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.OrderExpired.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_takerExpired_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        p.taker.expiry = uint64(block.timestamp - 1);

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.OrderExpired.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_makerNullifierAlreadySpent_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();

        vm.prank(makerRelayer);
        settlement.settleAuth(p);

        // Replay with a fresh taker side but the same maker nullifier
        PrivateSettlement.SettleAuthParams memory p2 = _defaultParams();
        p2.taker.nullifier = bytes32(uint256(0xBB1));
        p2.taker.nonceNullifier = bytes32(uint256(0xBB2));
        p2.taker.newCommitment = bytes32(uint256(0xBB3));
        p2.taker.claimsRoot = bytes32(uint256(0xBB4));

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.settleAuth(p2);
    }

    /// @notice [Security regression test for PR #133 gemini #3061594760]
    ///         An attacker submits two authorize.circom proofs against the
    ///         **same** escrow commitment (same secret + salt → same
    ///         escrow nullifier on both sides). Without the intra-tx
    ///         equality check in step 9, both per-mapping checks would
    ///         pass (the nullifier is being processed for the first time
    ///         in this transaction) and the contract would drain
    ///         2 × totalLocked from the pool while only one commitment
    ///         was actually consumed. The fix is the early `if (m.nullifier
    ///         == t.nullifier) revert NullifierAlreadySpent();` check.
    function test_settleAuth_intraTxSameEscrowNullifier_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Force both sides to share the escrow nullifier
        p.taker.nullifier = M_NULL;

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.settleAuth(p);
    }

    /// @notice Symmetric to the above for the nonce nullifier. Without the
    ///         second intra-tx equality check, an attacker who happened to
    ///         construct two proofs colliding on the nonce nullifier (e.g.
    ///         via a Poseidon collision in the unlikely worst case, or via
    ///         a buggy client that re-used a nonce) could trigger the same
    ///         pool-drain pattern.
    function test_settleAuth_intraTxSameNonceNullifier_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Force both sides to share the nonce nullifier
        p.taker.nonceNullifier = M_NONCE_NULL;

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.settleAuth(p);
    }

    // ────────────────────────────────────────────────────────────
    //  Authorisation, configuration, gating
    // ────────────────────────────────────────────────────────────

    function test_settleAuth_unauthorizedCaller_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        address randomCaller = address(0xBAD);

        vm.prank(randomCaller);
        vm.expectRevert(PrivateSettlement.NotMakerOrTakerRelayer.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_authorizeVerifierNotSet_reverts() public {
        // Disable the verifier
        settlement.setAuthorizeVerifier(address(0));
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.AuthorizeVerifierNotSet.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_paused_reverts() public {
        settlement.setPaused(true);
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_unwhitelistedToken_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Use a non-whitelisted token on both sides (so the cross-side
        // equality holds and we hit TokenNotWhitelisted, not TokenSidesMismatch)
        address newToken = address(0xC0FFEE);
        p.maker.sellToken = newToken;
        p.taker.buyToken = newToken;

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.TokenNotWhitelisted.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_invalidProof_reverts() public {
        authVerifier.setShouldPass(false);
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_relayerRegistry_blocksInactiveRelayer() public {
        // Wire up a registry and only register the maker relayer.
        // takerRelayer is intentionally NOT registered, so the registry's
        // active-relayer check should reject the settlement.
        address treasury = address(0x77EA);
        MockIdentityRegistry idRegistry = new MockIdentityRegistry();
        idRegistry.setVerified(makerRelayer, true);
        idRegistry.setVerified(takerRelayer, true);
        RelayerRegistry registry = new RelayerRegistry(treasury, address(idRegistry), address(0));

        // Fund makerRelayer and register; takerRelayer stays unregistered.
        vm.deal(makerRelayer, 1 ether);
        vm.prank(makerRelayer);
        registry.register{value: 0}("https://maker.example", 10, 0);

        settlement.setRelayerRegistry(address(registry));

        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.NotActiveRelayer.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_duplicateClaimsRoot_reverts() public {
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        // Same claims root on both sides, both with non-zero locked
        p.taker.claimsRoot = M_CLAIMS_R;

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.DuplicateClaimsRoot.selector);
        settlement.settleAuth(p);
    }

    // ────────────────────────────────────────────────────────────
    //  Batch verifier integration
    // ────────────────────────────────────────────────────────────

    function test_settleAuth_batchVerifier_happyPath() public {
        MockBatchAuthorizeVerifier batchVerifier = new MockBatchAuthorizeVerifier();
        settlement.setBatchAuthorizeVerifier(address(batchVerifier));

        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        vm.prank(makerRelayer);
        settlement.settleAuth(p);

        // Verify settlement completed (nullifiers marked)
        assertTrue(settlement.nullifiers(M_NULL));
        assertTrue(settlement.nullifiers(T_NULL));
    }

    function test_settleAuth_batchVerifier_invalidProof_reverts() public {
        MockBatchAuthorizeVerifier batchVerifier = new MockBatchAuthorizeVerifier();
        batchVerifier.setShouldPass(false);
        settlement.setBatchAuthorizeVerifier(address(batchVerifier));

        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.settleAuth(p);
    }

    function test_settleAuth_batchVerifier_disabledFallsBackToSingle() public {
        // First enable batch, then disable it
        MockBatchAuthorizeVerifier batchVerifier = new MockBatchAuthorizeVerifier();
        settlement.setBatchAuthorizeVerifier(address(batchVerifier));
        settlement.setBatchAuthorizeVerifier(address(0));

        // Should use the single authorizeVerifier (still set from setUp)
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        vm.prank(makerRelayer);
        settlement.settleAuth(p);
        assertTrue(settlement.nullifiers(M_NULL));
    }

    // ────────────────────────────────────────────────────────────
    //  setBatchAuthorizeVerifier setter tests
    // ────────────────────────────────────────────────────────────

    function test_setBatchAuthorizeVerifier_validContract() public {
        MockBatchAuthorizeVerifier batchVerifier = new MockBatchAuthorizeVerifier();

        vm.expectEmit(true, true, false, false);
        emit PrivateSettlement.BatchAuthorizeVerifierUpdated(address(0), address(batchVerifier));
        settlement.setBatchAuthorizeVerifier(address(batchVerifier));

        assertEq(address(settlement.batchAuthorizeVerifier()), address(batchVerifier));
    }

    function test_setBatchAuthorizeVerifier_disableWithZero() public {
        MockBatchAuthorizeVerifier batchVerifier = new MockBatchAuthorizeVerifier();
        settlement.setBatchAuthorizeVerifier(address(batchVerifier));

        vm.expectEmit(true, true, false, false);
        emit PrivateSettlement.BatchAuthorizeVerifierUpdated(address(batchVerifier), address(0));
        settlement.setBatchAuthorizeVerifier(address(0));

        assertEq(address(settlement.batchAuthorizeVerifier()), address(0));
    }

    function test_setBatchAuthorizeVerifier_rejectsEOA() public {
        address eoa = address(0xDEAD);
        vm.expectRevert();
        settlement.setBatchAuthorizeVerifier(eoa);
    }

    function test_setBatchAuthorizeVerifier_onlyOwner() public {
        MockBatchAuthorizeVerifier batchVerifier = new MockBatchAuthorizeVerifier();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        settlement.setBatchAuthorizeVerifier(address(batchVerifier));
    }

    // ════════════════════════════════════════════════════════════
    //  scatterDirectAuth — single-party, same-token via authorize proof
    // ════════════════════════════════════════════════════════════

    bytes32 constant SD_NULL       = bytes32(uint256(0xd1));
    bytes32 constant SD_NONCE_NULL = bytes32(uint256(0xd2));
    bytes32 constant SD_NEW_COMMIT = bytes32(uint256(0xd3));
    bytes32 constant SD_CLAIMS_R   = bytes32(uint256(0xd4));
    bytes32 constant SD_ORDER_HASH = bytes32(uint256(0xd5));

    function _defaultScatterDirectAuth() internal view returns (PrivateSettlement.ScatterDirectAuthParams memory) {
        return PrivateSettlement.ScatterDirectAuthParams({
            proof: SettleVerifyLib.AuthorizeProof({
                proofA: proofA,
                proofB: proofB,
                proofC: proofC,
                pubKeyBind: bytes32(uint256(0xD0)),
                commitmentRoot: pool.getLastRoot(),
                nullifier: SD_NULL,
                nonceNullifier: SD_NONCE_NULL,
                newCommitment: SD_NEW_COMMIT,
                sellToken: address(usdc),
                buyToken: address(usdc),       // same token
                sellAmount: 10_000e18,
                buyAmount: 9_000e18,
                maxFee: 100,                   // 1%
                expiry: uint64(block.timestamp + 1 hours),
                claimsRoot: SD_CLAIMS_R,
                totalLocked: uint128(9_900e18),
                relayer: makerRelayer,
                orderHash: SD_ORDER_HASH
            }),
            fee: 0
        });
    }

    function test_scatterDirectAuth_happyPath_zeroFee() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();

        vm.prank(makerRelayer);
        settlement.scatterDirectAuth(p);

        assertTrue(settlement.nullifiers(SD_NULL));
        assertTrue(settlement.nonceNullifiers(SD_NONCE_NULL));
        (uint128 locked,, address token) = settlement.claimsGroups(SD_CLAIMS_R);
        assertEq(token, address(usdc));
        assertEq(locked, uint128(9_900e18));
    }

    function test_scatterDirectAuth_happyPath_withFee() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        p.fee = uint96(100e18); // 1% of 10_000e18
        // totalLocked + fee <= sellAmount: 9900 + 100 = 10000 ✓

        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.prank(makerRelayer);
        settlement.scatterDirectAuth(p);

        // Pool should have lost totalLocked + fee
        assertEq(usdc.balanceOf(address(pool)), poolBefore - 9_900e18 - 100e18);
    }

    function test_scatterDirectAuth_revert_differentTokens() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        p.proof.buyToken = address(weth); // different from sellToken

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.SellBuyTokenMismatch.selector);
        settlement.scatterDirectAuth(p);
    }

    function test_scatterDirectAuth_revert_wrongRelayer() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();

        vm.prank(takerRelayer); // not proof.relayer
        vm.expectRevert(PrivateSettlement.NotMakerOrTakerRelayer.selector);
        settlement.scatterDirectAuth(p);
    }

    function test_scatterDirectAuth_revert_feeExceedsMax() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        // maxFee = 100 bps = 1%. sellAmount = 10_000e18
        // max fee = 10_000e18 * 100 / 10000 = 100e18
        p.fee = uint96(101e18); // above max
        p.proof.totalLocked = uint128(9_000e18); // ensure cap passes

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.FeeExceedsMax.selector);
        settlement.scatterDirectAuth(p);
    }

    function test_scatterDirectAuth_revert_claimsCapExceeded() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        p.proof.totalLocked = uint128(10_000e18);
        p.fee = uint96(1); // totalLocked + fee > sellAmount

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.ClaimsCapExceeded.selector);
        settlement.scatterDirectAuth(p);
    }

    function test_scatterDirectAuth_revert_expired() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        p.proof.expiry = uint64(block.timestamp - 1);

        vm.prank(makerRelayer);
        vm.expectRevert(SettleVerifyLib.OrderExpired.selector);
        settlement.scatterDirectAuth(p);
    }

    function test_scatterDirectAuth_revert_nullifierReplay() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        vm.prank(makerRelayer);
        settlement.scatterDirectAuth(p);

        // Second call — same nullifier
        PrivateSettlement.ScatterDirectAuthParams memory p2 = _defaultScatterDirectAuth();
        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.scatterDirectAuth(p2);
    }

    function test_scatterDirectAuth_revert_invalidProof() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        authVerifier.setShouldPass(false);

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.scatterDirectAuth(p);

        authVerifier.setShouldPass(true);
    }

    function test_scatterDirectAuth_revert_paused() public {
        settlement.setPaused(true);
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.scatterDirectAuth(p);

        settlement.setPaused(false);
    }

    function test_scatterDirectAuth_revert_tokenNotWhitelisted() public {
        SAToken bad = new SAToken("BAD", "BAD");
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        p.proof.sellToken = address(bad);
        p.proof.buyToken = address(bad);

        vm.prank(makerRelayer);
        vm.expectRevert(PrivateSettlement.TokenNotWhitelisted.selector);
        settlement.scatterDirectAuth(p);
    }

    function test_scatterDirectAuth_zeroNewCommitment_skipsInsert() public {
        PrivateSettlement.ScatterDirectAuthParams memory p = _defaultScatterDirectAuth();
        p.proof.newCommitment = bytes32(0); // fully spent

        uint32 nextBefore = pool.nextIndex();

        vm.prank(makerRelayer);
        settlement.scatterDirectAuth(p);

        // nextIndex should NOT have incremented (no commitment inserted)
        assertEq(pool.nextIndex(), nextBefore);
    }
}
