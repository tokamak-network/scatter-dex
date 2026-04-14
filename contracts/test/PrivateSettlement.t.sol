// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {SettleVerifyLib} from "../src/zk/SettleVerifyLib.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockSettleVerifier} from "./mocks/MockSettleVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract PrivateSettlementTest is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    MockVerifier public withdrawVerifier;
    MockDepositVerifier public depositVerifier;
    MockSettleVerifier public settleVerifier;
    MockClaimVerifier public claimVerifier;
    MockWETH public weth;
    MockToken public usdc;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address recipient1 = address(0xC1);
    address recipient2 = address(0xC2);

    // Dummy values for ZK proof params (mock verifier accepts anything)
    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant MAKER_NULL = bytes32(uint256(0xaa));
    bytes32 constant TAKER_NULL = bytes32(uint256(0xbb));
    bytes32 constant MAKER_NONCE_NULL = bytes32(uint256(0xcc));
    bytes32 constant TAKER_NONCE_NULL = bytes32(uint256(0xdd));
    bytes32 constant MAKER_NEW_COMMIT = bytes32(uint256(0x111));
    bytes32 constant TAKER_NEW_COMMIT = bytes32(uint256(0x222));
    bytes32 constant CLAIMS_ROOT_MAKER = bytes32(uint256(0x333));
    bytes32 constant CLAIMS_ROOT_TAKER = bytes32(uint256(0x444));
    bytes32 constant CLAIM_NULL_1 = bytes32(uint256(0x555));
    bytes32 constant CLAIM_NULL_2 = bytes32(uint256(0x666));
    bytes32 constant CLAIM_NULL_3 = bytes32(uint256(0x777));
    bytes32 constant CLAIM_NULL_4 = bytes32(uint256(0x888));
    bytes32 constant CLAIMS_ROOT_EMPTY = bytes32(uint256(0x999));

    function setUp() public {
        withdrawVerifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        settleVerifier = new MockSettleVerifier();
        claimVerifier = new MockClaimVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        weth = new MockWETH();
        settlement = new PrivateSettlement(address(pool), address(settleVerifier), address(claimVerifier), address(weth));
        usdc = new MockToken("USDC", "USDC");

        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);

        // Authorize settlement contract to insert commitments into the pool
        pool.setAuthorizedSettlement(address(settlement));

        // Fund pool with WETH (wrap ETH → WETH, then transfer to pool)
        vm.deal(address(this), 1100 ether);
        weth.deposit{value: 1100 ether}();
        weth.transfer(address(pool), 1000 ether);

        usdc.mint(address(pool), 100_000e18);

        // Fund alice with WETH for deposit
        weth.transfer(alice, 100 ether);
        vm.prank(alice);
        weth.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        pool.deposit(proofA, proofB, proofC, uint256(0x1234), address(weth), 10 ether);
    }

    // ─── settlePrivate Tests ─────────────────────────────────────

    function test_settlePrivate_basic() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Nullifiers should be marked
        assertTrue(settlement.nullifiers(MAKER_NULL));
        assertTrue(settlement.nullifiers(TAKER_NULL));
        assertTrue(settlement.nonceNullifiers(MAKER_NONCE_NULL));
        assertTrue(settlement.nonceNullifiers(TAKER_NONCE_NULL));

        // Claims groups should be registered
        (uint128 locked1, uint128 claimed1, address token1) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(token1, address(weth));
        assertEq(locked1, 5 ether);
        assertEq(claimed1, 0);

        (uint128 locked2,, address token2) = settlement.claimsGroups(CLAIMS_ROOT_TAKER);
        assertEq(token2, address(usdc));
        assertEq(locked2, 10_000e18);
    }

    function test_settlePrivate_emits_event() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();

        vm.expectEmit(true, true, false, true);
        emit PrivateSettlement.PrivateSettled(MAKER_NULL, TAKER_NULL, CLAIMS_ROOT_MAKER, CLAIMS_ROOT_TAKER, address(this), 0, 0);

        settlement.settlePrivate(p);
    }

    function test_settlePrivate_double_nullifier_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_invalid_proof_reverts() public {
        settleVerifier.setShouldPass(false);
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_paused_reverts() public {
        settlement.setPaused(true);
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();

        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_unwhitelisted_token_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        p.tokenMaker = address(0xDEAD);

        vm.expectRevert(PrivateSettlement.TokenNotWhitelisted.selector);
        settlement.settlePrivate(p);
    }

    // ─── claimWithProof Tests ────────────────────────────────────

    function test_claimWithProof_basic() public {
        // First settle to create a claims group
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        uint256 claimAmount = 2 ether;
        uint256 releaseTime = block.timestamp; // immediately claimable

        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER,
            CLAIM_NULL_1,
            claimAmount,
            address(weth),
            recipient1,
            releaseTime
        );

        // Recipient received ETH (WETH auto-unwrapped)
        assertEq(recipient1.balance, claimAmount);
        assertTrue(settlement.claimNullifiers(CLAIM_NULL_1));

        // Claims group updated
        (, uint128 claimed,) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, claimAmount);
    }

    function test_claimWithProof_multiple_claims() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Claim 1
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            2 ether, address(weth), recipient1, block.timestamp
        );

        // Claim 2
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_2,
            3 ether, address(weth), recipient2, block.timestamp
        );

        assertEq(recipient1.balance, 2 ether);
        assertEq(recipient2.balance, 3 ether);

        (, uint128 claimed,) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 5 ether); // all claimed
    }

    function test_claimWithProof_exceeds_locked_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        vm.expectRevert(PrivateSettlement.ExceedsTotalLocked.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            6 ether, // exceeds 5 ether locked
            address(weth), recipient1, block.timestamp
        );
    }

    function test_claimWithProof_double_claim_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1, block.timestamp
        );

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1, block.timestamp
        );
    }

    function test_claimWithProof_not_yet_releasable_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        vm.expectRevert(PrivateSettlement.NotYetReleasable.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1,
            block.timestamp + 1 hours // future release time
        );
    }

    function test_claimWithProof_invalid_proof_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        claimVerifier.setShouldPass(false);

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1, block.timestamp
        );
    }

    function test_claimWithProof_far_future_still_succeeds() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        uint256 releaseTime = block.timestamp; // capture before warp

        // Warp 1 year into the future — claims should still work (no expiry)
        vm.warp(block.timestamp + 365 days);

        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            2 ether, address(weth), recipient1, releaseTime
        );

        (, uint128 claimed,) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 2 ether);
    }

    // ─── claimWithProofBatch Tests ───────────────────────────────

    function _makeClaimParams(
        bytes32 claimsRoot,
        bytes32 nullifier,
        uint256 amount,
        address token,
        address recipient,
        uint256 releaseTime
    ) internal view returns (PrivateSettlement.ClaimParams memory) {
        return PrivateSettlement.ClaimParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            claimsRoot: claimsRoot,
            claimNullifier: nullifier,
            amount: amount,
            token: token,
            recipient: recipient,
            releaseTime: releaseTime
        });
    }

    function test_claimWithProofBatch_basic() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        PrivateSettlement.ClaimParams[] memory batch = new PrivateSettlement.ClaimParams[](2);
        batch[0] = _makeClaimParams(CLAIMS_ROOT_MAKER, CLAIM_NULL_1, 2 ether, address(weth), recipient1, block.timestamp);
        batch[1] = _makeClaimParams(CLAIMS_ROOT_MAKER, CLAIM_NULL_2, 3 ether, address(weth), recipient2, block.timestamp);

        settlement.claimWithProofBatch(batch);

        assertEq(recipient1.balance, 2 ether);
        assertEq(recipient2.balance, 3 ether);
        assertTrue(settlement.claimNullifiers(CLAIM_NULL_1));
        assertTrue(settlement.claimNullifiers(CLAIM_NULL_2));
        (, uint128 claimed,) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 5 ether);
    }

    function test_claimWithProofBatch_cross_group() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        PrivateSettlement.ClaimParams[] memory batch = new PrivateSettlement.ClaimParams[](2);
        batch[0] = _makeClaimParams(CLAIMS_ROOT_MAKER, CLAIM_NULL_1, 2 ether, address(weth), recipient1, block.timestamp);
        batch[1] = _makeClaimParams(CLAIMS_ROOT_TAKER, CLAIM_NULL_3, 4000e18, address(usdc), recipient2, block.timestamp);

        settlement.claimWithProofBatch(batch);

        assertEq(recipient1.balance, 2 ether);
        assertEq(usdc.balanceOf(recipient2), 4000e18);
    }

    function test_claimWithProofBatch_empty_reverts() public {
        PrivateSettlement.ClaimParams[] memory batch = new PrivateSettlement.ClaimParams[](0);
        vm.expectRevert(PrivateSettlement.EmptyBatch.selector);
        settlement.claimWithProofBatch(batch);
    }

    function test_claimWithProofBatch_too_large_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        uint256 oversize = settlement.MAX_CLAIM_BATCH_SIZE() + 1;
        PrivateSettlement.ClaimParams[] memory batch = new PrivateSettlement.ClaimParams[](oversize);
        for (uint256 i = 0; i < oversize; i++) {
            batch[i] = _makeClaimParams(CLAIMS_ROOT_MAKER, bytes32(uint256(0xAA00 + i)), 1 wei, address(weth), recipient1, block.timestamp);
        }

        vm.expectRevert(PrivateSettlement.BatchTooLarge.selector);
        settlement.claimWithProofBatch(batch);
    }

    function test_claimWithProofBatch_atomic_failure_reverts_all() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        PrivateSettlement.ClaimParams[] memory batch = new PrivateSettlement.ClaimParams[](2);
        batch[0] = _makeClaimParams(CLAIMS_ROOT_MAKER, CLAIM_NULL_1, 2 ether, address(weth), recipient1, block.timestamp);
        // Second claim uses same nullifier → will revert on the second iteration
        batch[1] = _makeClaimParams(CLAIMS_ROOT_MAKER, CLAIM_NULL_1, 1 ether, address(weth), recipient2, block.timestamp);

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimWithProofBatch(batch);

        // Neither claim applied
        assertEq(recipient1.balance, 0);
        assertEq(recipient2.balance, 0);
        assertFalse(settlement.claimNullifiers(CLAIM_NULL_1));
        (, uint128 claimed,) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 0);
    }

    function test_claimWithProofBatch_paused_reverts() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);
        settlement.setPaused(true);

        PrivateSettlement.ClaimParams[] memory batch = new PrivateSettlement.ClaimParams[](1);
        batch[0] = _makeClaimParams(CLAIMS_ROOT_MAKER, CLAIM_NULL_1, 1 ether, address(weth), recipient1, block.timestamp);

        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.claimWithProofBatch(batch);
    }

    function test_receive_rejects_non_weth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(settlement).call{value: 1 ether}("");
        assertFalse(ok, "Should reject ETH from non-WETH address");
    }

    // ─── E2E: Full Private Flow ──────────────────────────────────

    function test_e2e_deposit_settle_claim_change() public {
        // Full flow: deposit → settle → claim (WETH auto-unwrap) → verify change commitment

        // 1. Settle creates claims groups and inserts change commitments
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Verify claims groups created
        (uint128 locked, uint128 claimed, address token) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(token, address(weth));
        assertEq(locked, 5 ether);
        assertEq(claimed, 0);

        // 2. Claim #1 — WETH auto-unwrapped to ETH
        uint256 claimAmount1 = 2 ether;
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            claimAmount1, address(weth), recipient1, block.timestamp
        );

        // Recipient received ETH (not WETH)
        assertEq(recipient1.balance, claimAmount1, "recipient1 should receive ETH");
        assertEq(weth.balanceOf(recipient1), 0, "recipient1 should have no WETH");

        // Nullifier marked
        assertTrue(settlement.claimNullifiers(CLAIM_NULL_1));

        // Claims group updated
        (, claimed,) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, claimAmount1);

        // 3. Claim #2 — remaining amount
        uint256 claimAmount2 = 3 ether;
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_2,
            claimAmount2, address(weth), recipient2, block.timestamp
        );

        assertEq(recipient2.balance, claimAmount2, "recipient2 should receive ETH");
        assertTrue(settlement.claimNullifiers(CLAIM_NULL_2));

        // All claims done — totalClaimed == totalLocked
        (, claimed,) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 5 ether, "all claims should be consumed");

        // 4. Verify double-claim is rejected
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1, block.timestamp
        );

        // 5. Verify conservation: settlement contract should have 0 WETH
        //    (all claimed amounts have been unwrapped and sent as ETH)
        assertEq(weth.balanceOf(address(settlement)), 0, "settlement should hold no WETH after full claim");
    }

    function test_e2e_taker_claim_usdc() public {
        // Verify taker-side claim works with non-WETH token (no auto-unwrap)
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Taker claims USDC (should receive as ERC20, not ETH)
        uint256 claimAmount = 4000e18;
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_TAKER, CLAIM_NULL_3,
            claimAmount, address(usdc), recipient1, block.timestamp
        );

        assertEq(usdc.balanceOf(recipient1), claimAmount, "taker recipient should receive USDC");
        assertEq(recipient1.balance, 0, "no ETH should be sent for non-WETH claim");

        (, uint128 claimed,) = settlement.claimsGroups(CLAIMS_ROOT_TAKER);
        assertEq(claimed, claimAmount);
    }

    function test_e2e_overclaim_reverts() public {
        // Claim with new nullifier but exceeding totalLocked should revert
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Claim full maker amount (5 ether)
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            5 ether, address(weth), recipient1, block.timestamp
        );

        // Try claiming more with a fresh nullifier — should revert ExceedsTotalLocked
        vm.expectRevert(PrivateSettlement.ExceedsTotalLocked.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_4, // new nullifier
            1 ether, address(weth), recipient2, block.timestamp
        );
    }

    function test_e2e_settle_with_empty_taker() public {
        // Settlement where taker has 0 locked (one-sided claims)
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        p.totalLockedTaker = 0;
        p.claimsRootTaker = CLAIMS_ROOT_EMPTY;
        p.tokenTaker = address(usdc);
        settlement.settlePrivate(p);

        // Claim from maker's claims root
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            2 ether, address(weth), recipient1, block.timestamp
        );

        assertEq(recipient1.balance, 2 ether);

        // Taker's empty group should exist but have 0 locked
        (uint128 locked2,, address t2) = settlement.claimsGroups(CLAIMS_ROOT_EMPTY);
        assertEq(t2, address(usdc));
        assertEq(locked2, 0);
    }

    function test_e2e_duplicate_claims_root_reverts() public {
        // Same claimsRoot for maker and taker (both non-zero locked) → should revert
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        p.claimsRootTaker = p.claimsRootMaker; // force duplicate
        vm.expectRevert(PrivateSettlement.DuplicateClaimsRoot.selector);
        settlement.settlePrivate(p);
    }

    function test_e2e_claimsGroup_overwrite_blocked() public {
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // New nullifiers but same claimsRootMaker → should revert
        SettleVerifyLib.SettleParams memory p2 = _defaultSettleParams();
        p2.makerNullifier = bytes32(uint256(0xee));
        p2.takerNullifier = bytes32(uint256(0xff));
        p2.makerNonceNullifier = bytes32(uint256(0xee1));
        p2.takerNonceNullifier = bytes32(uint256(0xff1));
        vm.expectRevert(SettleVerifyLib.ClaimsGroupAlreadyExists.selector);
        settlement.settlePrivate(p2);
    }

    // ─── [M7] timestamp-tolerance hardening ──────────────────────

    function test_settlePrivate_rejects_future_timestamp() public {
        // Move chain time forward so the helper picks a known block.timestamp.
        vm.warp(1_000_000);
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        // Even one second into the future is rejected post-M7.
        p.currentTimestamp = block.timestamp + 1;
        vm.expectRevert(PrivateSettlement.TimestampOutOfRange.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_accepts_recent_past_timestamp() public {
        vm.warp(1_000_000);
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        // Within the 60-second window — still accepted (proof gen latency).
        p.currentTimestamp = block.timestamp - 30;
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_accepts_boundary_past_timestamp() public {
        vm.warp(1_000_000);
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        // Exactly at the boundary — `currentTimestamp + 60 == block.timestamp`
        // → not rejected.
        p.currentTimestamp = block.timestamp - 60;
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_rejects_too_old_timestamp() public {
        vm.warp(1_000_000);
        SettleVerifyLib.SettleParams memory p = _defaultSettleParams();
        // Beyond the 60-second window — rejected.
        p.currentTimestamp = block.timestamp - 61;
        vm.expectRevert(PrivateSettlement.TimestampOutOfRange.selector);
        settlement.settlePrivate(p);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _defaultSettleParams() internal view returns (SettleVerifyLib.SettleParams memory) {
        return SettleVerifyLib.SettleParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            currentRoot: pool.getLastRoot(),
            currentTimestamp: block.timestamp,
            makerNullifier: MAKER_NULL,
            takerNullifier: TAKER_NULL,
            makerNonceNullifier: MAKER_NONCE_NULL,
            takerNonceNullifier: TAKER_NONCE_NULL,
            makerNewCommitment: MAKER_NEW_COMMIT,
            takerNewCommitment: TAKER_NEW_COMMIT,
            claimsRootMaker: CLAIMS_ROOT_MAKER,
            claimsRootTaker: CLAIMS_ROOT_TAKER,
            totalLockedMaker: uint96(5 ether),
            totalLockedTaker: uint96(10_000e18),
            tokenMaker: address(weth),
            tokenTaker: address(usdc),
            feeTokenMaker: 0,
            feeTokenTaker: 0,
            makerRelayer: address(this),
            takerRelayer: address(this)
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
// FeeVault + Relayer Gating Tests
// ═══════════════════════════════════════════════════════════════════

contract FeeVaultTest is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    FeeVault public vault;
    RelayerRegistry public registry;
    MockVerifier public withdrawVerifier;
    MockDepositVerifier public depositVerifier;
    MockSettleVerifier public settleVerifier;
    MockClaimVerifier public claimVerifier;
    MockWETH public weth;
    MockToken public usdc;
    MockIdentityRegistry public identityRegistry;

    address deployer = address(this);
    address relayer = address(0x7E1A);
    address nonRelayer = address(0xBAD);
    address alice = address(0xA11CE);
    address recipient1 = address(0xC1);
    address treasury = address(0x77EA);

    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant MAKER_NULL = bytes32(uint256(0x1aa));
    bytes32 constant TAKER_NULL = bytes32(uint256(0x1bb));
    bytes32 constant MAKER_NONCE_NULL = bytes32(uint256(0x1cc));
    bytes32 constant TAKER_NONCE_NULL = bytes32(uint256(0x1dd));
    bytes32 constant MAKER_NEW_COMMIT = bytes32(uint256(0x1111));
    bytes32 constant TAKER_NEW_COMMIT = bytes32(uint256(0x2222));
    bytes32 constant CLAIMS_ROOT_MAKER = bytes32(uint256(0x3333));
    bytes32 constant CLAIMS_ROOT_TAKER = bytes32(uint256(0x4444));
    bytes32 constant CLAIM_NULL_1 = bytes32(uint256(0x5555));

    function setUp() public {
        withdrawVerifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        settleVerifier = new MockSettleVerifier();
        claimVerifier = new MockClaimVerifier();
        identityRegistry = new MockIdentityRegistry();
        weth = new MockWETH();
        usdc = new MockToken("USDC", "USDC");

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        settlement = new PrivateSettlement(address(pool), address(settleVerifier), address(claimVerifier), address(weth));

        // Deploy FeeVault: 5% platform fee (500 bps), treasury
        vault = new FeeVault(treasury, 500);
        vault.setAuthorizedDepositor(address(settlement), true);

        // Deploy RelayerRegistry with mock identity
        registry = new RelayerRegistry(treasury, address(identityRegistry));

        // Wire up
        settlement.setRelayerRegistry(address(registry));
        settlement.setFeeVault(address(vault));

        // Whitelist tokens
        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);
        pool.setAuthorizedSettlement(address(settlement));

        // Fund pool
        vm.deal(address(this), 1100 ether);
        weth.deposit{value: 1100 ether}();
        weth.transfer(address(pool), 1000 ether);
        usdc.mint(address(pool), 100_000e18);

        // Fund alice for deposit
        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        weth.deposit{value: 10 ether}();
        weth.approve(address(pool), type(uint256).max);
        pool.deposit(proofA, proofB, proofC, uint256(0x9876), address(weth), 10 ether);
        vm.stopPrank();

        // Verify + register relayer
        identityRegistry.setVerified(relayer, true);
        vm.prank(relayer);
        registry.register("http://localhost:3002", 30);
    }

    // ─── Relayer Gating ─────────────────────────────────────────

    function test_settlePrivate_only_active_relayer() public {
        SettleVerifyLib.SettleParams memory p = _params();

        // Non-relayer (not in proof) should be rejected
        vm.prank(nonRelayer);
        vm.expectRevert(PrivateSettlement.NotMakerOrTakerRelayer.selector);
        settlement.settlePrivate(p);

        // Registered relayer (in proof as both maker+taker) should succeed
        vm.prank(relayer);
        settlement.settlePrivate(p);
    }

    function test_scatterDirect_only_active_relayer() public {
        PrivateSettlement.ScatterDirectParams memory p = _scatterParams();

        vm.prank(nonRelayer);
        vm.expectRevert(PrivateSettlement.NotActiveRelayer.selector);
        settlement.scatterDirect(p);

        vm.prank(relayer);
        settlement.scatterDirect(p);
    }

    function test_disable_registry_still_requires_proof_relayer() public {
        // Disable relayer registry gating
        settlement.setRelayerRegistry(address(0));

        // Still restricted to maker/taker relayer bound in proof
        SettleVerifyLib.SettleParams memory p = _params();
        vm.prank(relayer); // relayer = makerRelayer = takerRelayer in _params
        settlement.settlePrivate(p);
    }

    // ─── Relayer Binding (proof front-run prevention) ─────────

    address constant RELAYER_2 = address(0x7E1B);

    function _registerRelayer2() internal {
        identityRegistry.setVerified(RELAYER_2, true);
        vm.prank(RELAYER_2);
        registry.register("http://localhost:3003", 30);
    }

    function test_settlePrivate_correct_relayer_passes_proof() public {
        settleVerifier.setEnforceRelayer(true, relayer, relayer);
        SettleVerifyLib.SettleParams memory p = _params();

        vm.prank(relayer);
        settlement.settlePrivate(p);

        assertTrue(settlement.nullifiers(p.makerNullifier));
    }

    function test_settlePrivate_wrong_relayer_reverts_proof() public {
        settleVerifier.setEnforceRelayer(true, relayer, relayer);
        _registerRelayer2();

        // Different nullifiers to avoid collision with other tests
        SettleVerifyLib.SettleParams memory p = _params();
        p.makerNullifier = bytes32(uint256(0x2aa));
        p.takerNullifier = bytes32(uint256(0x2bb));
        p.makerNonceNullifier = bytes32(uint256(0x2cc));
        p.takerNonceNullifier = bytes32(uint256(0x2dd));
        p.claimsRootMaker = bytes32(uint256(0x5333));
        p.claimsRootTaker = bytes32(uint256(0x5444));

        // Set RELAYER_2 as makerRelayer so they can submit, but mock verifier expects `relayer`
        p.makerRelayer = RELAYER_2;
        // RELAYER_2 submits → pubSignals[16] = RELAYER_2 ≠ expectedMakerRelayer(=relayer) → InvalidProof
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        vm.prank(RELAYER_2);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_cross_relayer_fee_split() public {
        // Cross-relayer: maker=relayer, taker=RELAYER_2
        _registerRelayer2();

        SettleVerifyLib.SettleParams memory p = _params();
        p.makerNullifier = bytes32(uint256(0x3aa));
        p.takerNullifier = bytes32(uint256(0x3bb));
        p.makerNonceNullifier = bytes32(uint256(0x3cc));
        p.takerNonceNullifier = bytes32(uint256(0x3dd));
        p.claimsRootMaker = bytes32(uint256(0x6333));
        p.claimsRootTaker = bytes32(uint256(0x6444));
        p.takerRelayer = RELAYER_2;

        // Set fees: feeTokenMaker (WETH = maker.buyToken) + feeTokenTaker (USDC = taker.buyToken)
        p.feeTokenMaker = uint96(0.1 ether);  // fee drawn from maker's buyAmount → makerRelayer
        p.feeTokenTaker = uint96(50e18);       // fee drawn from taker's buyAmount → takerRelayer

        // RELAYER_2 (takerRelayer) submits
        vm.prank(RELAYER_2);
        settlement.settlePrivate(p);

        // Fee split assertions (fee-semantics redesign: each user's fee goes
        // to the relayer holding their order):
        // feeTokenMaker (WETH) → makerRelayer (relayer)
        assertEq(vault.balances(relayer, address(weth)), 0.1 ether, "makerRelayer should receive feeTokenMaker (WETH)");
        assertEq(vault.balances(RELAYER_2, address(weth)), 0, "takerRelayer should NOT receive feeTokenMaker");

        // feeTokenTaker (USDC) → takerRelayer (RELAYER_2)
        assertEq(vault.balances(RELAYER_2, address(usdc)), 50e18, "takerRelayer should receive feeTokenTaker (USDC)");
        assertEq(vault.balances(relayer, address(usdc)), 0, "makerRelayer should NOT receive feeTokenTaker");
    }

    // ─── FeeVault ───────────────────────────────────────────────

    function test_fees_go_to_vault() public {
        SettleVerifyLib.SettleParams memory p = _params();
        p.feeTokenMaker = uint96(0.1 ether); // 0.1 WETH fee

        vm.prank(relayer);
        settlement.settlePrivate(p);

        // Fee should be in vault, credited to relayer
        assertEq(vault.balances(relayer, address(weth)), 0.1 ether, "vault should credit relayer");
        assertEq(weth.balanceOf(address(vault)), 0.1 ether, "vault should hold WETH");
    }

    function test_fees_both_tokens_same_relayer() public {
        // Local match: same relayer for both sides → all fees go to that relayer
        SettleVerifyLib.SettleParams memory p = _params();
        p.feeTokenMaker = uint96(0.05 ether);  // fee in WETH → makerRelayer (= relayer)
        p.feeTokenTaker = uint96(100e18);       // fee in USDC → takerRelayer (= relayer)

        vm.prank(relayer);
        settlement.settlePrivate(p);

        // Both fees go to same relayer (makerRelayer == takerRelayer)
        assertEq(vault.balances(relayer, address(weth)), 0.05 ether);
        assertEq(vault.balances(relayer, address(usdc)), 100e18);
    }

    function test_relayer_claims_from_vault() public {
        // Settle with fee
        SettleVerifyLib.SettleParams memory p = _params();
        p.feeTokenMaker = uint96(1 ether);

        vm.prank(relayer);
        settlement.settlePrivate(p);

        // Relayer claims from vault
        uint256 relayerBalBefore = weth.balanceOf(relayer);
        uint256 treasuryBalBefore = weth.balanceOf(treasury);

        vm.prank(relayer);
        vault.claim(address(weth));

        // 5% platform fee: 0.05 ETH to treasury, 0.95 ETH to relayer
        assertEq(weth.balanceOf(relayer) - relayerBalBefore, 0.95 ether, "relayer gets 95%");
        assertEq(weth.balanceOf(treasury) - treasuryBalBefore, 0.05 ether, "treasury gets 5%");
        assertEq(vault.balances(relayer, address(weth)), 0, "vault balance should be 0");
    }

    function test_relayer_claims_usdc_from_vault() public {
        SettleVerifyLib.SettleParams memory p = _params();
        p.feeTokenTaker = uint96(200e18); // USDC fee

        vm.prank(relayer);
        settlement.settlePrivate(p);

        vm.prank(relayer);
        vault.claim(address(usdc));

        // 5% of 200 USDC = 10 USDC to treasury, 190 USDC to relayer
        assertEq(usdc.balanceOf(relayer), 190e18, "relayer gets 190 USDC");
        assertEq(usdc.balanceOf(treasury), 200e18 - 190e18, "treasury gets 10 USDC");
    }

    function test_vault_nothing_to_claim_reverts() public {
        vm.prank(relayer);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claim(address(weth));
    }

    function test_vault_unauthorized_deposit_reverts() public {
        vm.prank(nonRelayer);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.deposit(relayer, address(weth), 1 ether);
    }

    function test_scatterDirect_fee_to_vault() public {
        PrivateSettlement.ScatterDirectParams memory p = _scatterParams();
        p.fee = uint96(0.03 ether);
        p.withdrawAmount = uint256(p.totalLocked) + uint256(p.fee);

        vm.prank(relayer);
        settlement.scatterDirect(p);

        assertEq(vault.balances(relayer, address(weth)), 0.03 ether);
    }

    function test_disable_vault_fees_go_to_relayer() public {
        // Disable vault
        settlement.setFeeVault(address(0));

        SettleVerifyLib.SettleParams memory p = _params();
        p.feeTokenMaker = uint96(0.1 ether);

        uint256 relayerBalBefore = weth.balanceOf(relayer);

        vm.prank(relayer);
        settlement.settlePrivate(p);

        // Fee goes directly to relayer (legacy mode)
        assertEq(weth.balanceOf(relayer) - relayerBalBefore, 0.1 ether);
        assertEq(vault.balances(relayer, address(weth)), 0);
    }

    // ─── Platform Fee Admin ─────────────────────────────────────

    function test_vault_platform_fee_update() public {
        vault.scheduleFeeChange(1000); // 10%
        vm.warp(block.timestamp + vault.FEE_CHANGE_DELAY());
        vault.applyFeeChange();
        assertEq(vault.platformFeeBps(), 1000);

        // Settle with fee
        SettleVerifyLib.SettleParams memory p = _params();
        p.feeTokenMaker = uint96(1 ether);
        vm.prank(relayer);
        settlement.settlePrivate(p);

        // Claim — 10% platform fee
        vm.prank(relayer);
        vault.claim(address(weth));

        assertEq(weth.balanceOf(treasury), 0.1 ether, "10% to treasury");
    }

    function test_vault_max_platform_fee() public {
        vm.expectRevert(FeeVault.FeeTooHigh.selector);
        vault.scheduleFeeChange(5001); // > 50%
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _params() internal view returns (SettleVerifyLib.SettleParams memory) {
        return SettleVerifyLib.SettleParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            currentRoot: pool.getLastRoot(),
            currentTimestamp: block.timestamp,
            makerNullifier: MAKER_NULL,
            takerNullifier: TAKER_NULL,
            makerNonceNullifier: MAKER_NONCE_NULL,
            takerNonceNullifier: TAKER_NONCE_NULL,
            makerNewCommitment: MAKER_NEW_COMMIT,
            takerNewCommitment: TAKER_NEW_COMMIT,
            claimsRootMaker: CLAIMS_ROOT_MAKER,
            claimsRootTaker: CLAIMS_ROOT_TAKER,
            totalLockedMaker: uint96(5 ether),
            totalLockedTaker: uint96(10_000e18),
            tokenMaker: address(weth),
            tokenTaker: address(usdc),
            feeTokenMaker: 0,
            feeTokenTaker: 0,
            makerRelayer: relayer,
            takerRelayer: relayer
        });
    }

    function _scatterParams() internal view returns (PrivateSettlement.ScatterDirectParams memory) {
        return PrivateSettlement.ScatterDirectParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            currentRoot: pool.getLastRoot(),
            nullifier: bytes32(uint256(0xABCD)),
            newCommitment: bytes32(uint256(0xEF01)),
            token: address(weth),
            withdrawAmount: 5 ether,
            claimsRoot: bytes32(uint256(0xF333)),
            totalLocked: uint96(5 ether),
            fee: 0
        });
    }
}
