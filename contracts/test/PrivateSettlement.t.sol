// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
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
        settleVerifier = new MockSettleVerifier();
        claimVerifier = new MockClaimVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), 20, 30);
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
        pool.deposit(uint256(0x1234), address(weth), 10 ether);
    }

    // ─── settlePrivate Tests ─────────────────────────────────────

    function test_settlePrivate_basic() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Nullifiers should be marked
        assertTrue(settlement.nullifiers(MAKER_NULL));
        assertTrue(settlement.nullifiers(TAKER_NULL));
        assertTrue(settlement.nonceNullifiers(MAKER_NONCE_NULL));
        assertTrue(settlement.nonceNullifiers(TAKER_NONCE_NULL));

        // Claims groups should be registered
        (address token1, uint96 locked1, uint96 claimed1) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(token1, address(weth));
        assertEq(locked1, 5 ether);
        assertEq(claimed1, 0);

        (address token2, uint96 locked2,) = settlement.claimsGroups(CLAIMS_ROOT_TAKER);
        assertEq(token2, address(usdc));
        assertEq(locked2, 10_000e18);
    }

    function test_settlePrivate_emits_event() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();

        vm.expectEmit(true, true, false, true);
        emit PrivateSettlement.PrivateSettled(MAKER_NULL, TAKER_NULL, CLAIMS_ROOT_MAKER, CLAIMS_ROOT_TAKER, address(this), 0, 0);

        settlement.settlePrivate(p);
    }

    function test_settlePrivate_double_nullifier_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_invalid_proof_reverts() public {
        settleVerifier.setShouldPass(false);
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_paused_reverts() public {
        settlement.setPaused(true);
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();

        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_unwhitelisted_token_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        p.tokenMaker = address(0xDEAD);

        vm.expectRevert(PrivateSettlement.TokenNotWhitelisted.selector);
        settlement.settlePrivate(p);
    }

    // ─── claimWithProof Tests ────────────────────────────────────

    function test_claimWithProof_basic() public {
        // First settle to create a claims group
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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
        (,, uint96 claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, claimAmount);
    }

    function test_claimWithProof_multiple_claims() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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

        (,, uint96 claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 5 ether); // all claimed
    }

    function test_claimWithProof_exceeds_locked_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        uint256 releaseTime = block.timestamp; // capture before warp

        // Warp 1 year into the future — claims should still work (no expiry)
        vm.warp(block.timestamp + 365 days);

        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            2 ether, address(weth), recipient1, releaseTime
        );

        (,, uint96 claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 2 ether);
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
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Verify claims groups created
        (address token, uint96 locked, uint96 claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
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
        (,, claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
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
        (,, claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
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
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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

        (,, uint96 claimed) = settlement.claimsGroups(CLAIMS_ROOT_TAKER);
        assertEq(claimed, claimAmount);
    }

    function test_e2e_overclaim_reverts() public {
        // Claim with new nullifier but exceeding totalLocked should revert
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
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
        (address t2, uint96 locked2,) = settlement.claimsGroups(CLAIMS_ROOT_EMPTY);
        assertEq(t2, address(usdc));
        assertEq(locked2, 0);
    }

    function test_e2e_claimsGroup_overwrite_blocked() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // New nullifiers but same claimsRootMaker → should revert
        PrivateSettlement.SettleParams memory p2 = _defaultSettleParams();
        p2.makerNullifier = bytes32(uint256(0xee));
        p2.takerNullifier = bytes32(uint256(0xff));
        p2.makerNonceNullifier = bytes32(uint256(0xee1));
        p2.takerNonceNullifier = bytes32(uint256(0xff1));
        vm.expectRevert(PrivateSettlement.ClaimsGroupAlreadyExists.selector);
        settlement.settlePrivate(p2);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _defaultSettleParams() internal view returns (PrivateSettlement.SettleParams memory) {
        return PrivateSettlement.SettleParams({
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
            feeTokenTaker: 0
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
        settleVerifier = new MockSettleVerifier();
        claimVerifier = new MockClaimVerifier();
        identityRegistry = new MockIdentityRegistry();
        weth = new MockWETH();
        usdc = new MockToken("USDC", "USDC");

        pool = new CommitmentPool(address(withdrawVerifier), 20, 30);
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
        pool.deposit(uint256(0x9876), address(weth), 10 ether);
        vm.stopPrank();

        // Verify + register relayer
        identityRegistry.setVerified(relayer, true);
        vm.prank(relayer);
        registry.register("http://localhost:3002", 30);
    }

    // ─── Relayer Gating ─────────────────────────────────────────

    function test_settlePrivate_only_active_relayer() public {
        PrivateSettlement.SettleParams memory p = _params();

        // Non-relayer should be rejected
        vm.prank(nonRelayer);
        vm.expectRevert(PrivateSettlement.NotActiveRelayer.selector);
        settlement.settlePrivate(p);

        // Registered relayer should succeed
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

    function test_disable_relayer_gate() public {
        // Disable relayer gating
        settlement.setRelayerRegistry(address(0));

        // Now anyone can settle
        PrivateSettlement.SettleParams memory p = _params();
        vm.prank(nonRelayer);
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
        settleVerifier.setEnforceRelayer(true, relayer);
        PrivateSettlement.SettleParams memory p = _params();

        vm.prank(relayer);
        settlement.settlePrivate(p);

        assertTrue(settlement.nullifiers(p.makerNullifier));
    }

    function test_settlePrivate_wrong_relayer_reverts_proof() public {
        settleVerifier.setEnforceRelayer(true, relayer);
        _registerRelayer2();

        // Different nullifiers to avoid collision with other tests
        PrivateSettlement.SettleParams memory p = _params();
        p.makerNullifier = bytes32(uint256(0x2aa));
        p.takerNullifier = bytes32(uint256(0x2bb));
        p.makerNonceNullifier = bytes32(uint256(0x2cc));
        p.takerNonceNullifier = bytes32(uint256(0x2dd));
        p.claimsRootMaker = bytes32(uint256(0x5333));
        p.claimsRootTaker = bytes32(uint256(0x5444));

        // RELAYER_2 submits → pubSignals[16] = RELAYER_2 ≠ expectedRelayer → InvalidProof
        vm.prank(RELAYER_2);
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_no_enforce_any_relayer_passes() public {
        // enforceRelayer = false (default) → any registered relayer can settle
        _registerRelayer2();

        PrivateSettlement.SettleParams memory p = _params();
        p.makerNullifier = bytes32(uint256(0x3aa));
        p.takerNullifier = bytes32(uint256(0x3bb));
        p.makerNonceNullifier = bytes32(uint256(0x3cc));
        p.takerNonceNullifier = bytes32(uint256(0x3dd));
        p.claimsRootMaker = bytes32(uint256(0x6333));
        p.claimsRootTaker = bytes32(uint256(0x6444));

        vm.prank(RELAYER_2);
        settlement.settlePrivate(p); // should pass without enforce
    }

    // ─── FeeVault ───────────────────────────────────────────────

    function test_fees_go_to_vault() public {
        PrivateSettlement.SettleParams memory p = _params();
        p.feeTokenMaker = uint96(0.1 ether); // 0.1 WETH fee

        vm.prank(relayer);
        settlement.settlePrivate(p);

        // Fee should be in vault, credited to relayer
        assertEq(vault.balances(relayer, address(weth)), 0.1 ether, "vault should credit relayer");
        assertEq(weth.balanceOf(address(vault)), 0.1 ether, "vault should hold WETH");
    }

    function test_fees_both_tokens() public {
        PrivateSettlement.SettleParams memory p = _params();
        p.feeTokenMaker = uint96(0.05 ether);  // fee in WETH
        p.feeTokenTaker = uint96(100e18);       // fee in USDC

        vm.prank(relayer);
        settlement.settlePrivate(p);

        assertEq(vault.balances(relayer, address(weth)), 0.05 ether);
        assertEq(vault.balances(relayer, address(usdc)), 100e18);
    }

    function test_relayer_claims_from_vault() public {
        // Settle with fee
        PrivateSettlement.SettleParams memory p = _params();
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
        PrivateSettlement.SettleParams memory p = _params();
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

        PrivateSettlement.SettleParams memory p = _params();
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
        vault.setPlatformFee(1000); // 10%
        assertEq(vault.platformFeeBps(), 1000);

        // Settle with fee
        PrivateSettlement.SettleParams memory p = _params();
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
        vault.setPlatformFee(5001); // > 50%
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _params() internal view returns (PrivateSettlement.SettleParams memory) {
        return PrivateSettlement.SettleParams({
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
            feeTokenTaker: 0
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
