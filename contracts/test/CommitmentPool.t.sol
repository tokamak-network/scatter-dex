// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract CommitmentPoolTest is Test {
    CommitmentPool public pool;
    MockVerifier public verifier;
    MockDepositVerifier public depositVerifier;
    MockToken public token;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    // Test commitment / nullifier values must be < BN254 scalar field
    // (~2^253.9) so the upstream check in CommitmentPool.deposit() does
    // not reject them as `FieldElementOutOfRange`. We use values with a
    // safely-low leading nibble (0x0–0x1).
    uint256 constant COMMITMENT_1 = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    uint256 constant COMMITMENT_2 = 0x0edcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321;
    uint256 constant NULLIFIER_1 = 0x0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
    uint256 constant NULLIFIER_2 = 0x0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;

    function setUp() public {
        verifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        pool = ProxyDeployer.deployCommitmentPool(address(this), address(this), address(verifier), address(depositVerifier), 20, 30);
        token = new MockToken();

        pool.setTokenWhitelist(address(token), true);

        token.mint(alice, 1000 ether);
        token.mint(bob, 1000 ether);

        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        token.approve(address(pool), type(uint256).max);
    }

    /// @dev Helper: deposit with empty proof params (MockDepositVerifier always passes).
    function _deposit(uint256 commitment, address tok, uint256 amount) internal {
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        pool.deposit(pa, pb, pc, commitment, tok, amount);
    }

    // ─── Deposit Tests ───────────────────────────────────────────

    function test_deposit() public {
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        assertEq(token.balanceOf(address(pool)), 100 ether);
        assertEq(token.balanceOf(alice), 900 ether);
        assertEq(pool.nextIndex(), 1);
    }

    function test_deposit_updates_root() public {
        uint256 rootBefore = pool.getLastRoot();

        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 50 ether);

        uint256 rootAfter = pool.getLastRoot();
        assertTrue(rootBefore != rootAfter, "root should change after deposit");
        assertTrue(pool.isKnownRoot(rootAfter), "new root should be known");
    }

    function test_deposit_multiple() public {
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        vm.prank(bob);
        _deposit(COMMITMENT_2, address(token), 200 ether);

        assertEq(pool.nextIndex(), 2);
        assertEq(token.balanceOf(address(pool)), 300 ether);
    }

    function test_deposit_emits_event() public {
        vm.expectEmit(true, false, false, true);
        emit CommitmentPool.CommitmentInserted(COMMITMENT_1, 0, block.timestamp);

        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);
    }

    function test_deposit_zero_amount_reverts() public {
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.ZeroAmount.selector);
        _deposit(COMMITMENT_1, address(token), 0);
    }

    function test_deposit_zero_commitment_reverts() public {
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.ZeroCommitment.selector);
        _deposit(0, address(token), 100 ether);
    }

    function test_deposit_unwhitelisted_token_reverts() public {
        MockToken badToken = new MockToken();
        badToken.mint(alice, 100 ether);

        vm.prank(alice);
        vm.expectRevert(CommitmentPool.TokenNotWhitelisted.selector);
        _deposit(COMMITMENT_1, address(badToken), 100 ether);
    }

    function test_deposit_commitment_above_field_reverts() public {
        // BN254 modulus + 1 — guaranteed to exceed the field.
        uint256 BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        uint256 outOfField = BN254;
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.FieldElementOutOfRange.selector);
        _deposit(outOfField, address(token), 100 ether);
    }

    function test_deposit_amount_above_field_reverts() public {
        uint256 BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.FieldElementOutOfRange.selector);
        pool.deposit(pa, pb, pc, COMMITMENT_1, address(token), BN254);
    }

    function test_deposit_when_paused_reverts() public {
        pool.pause();

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        _deposit(COMMITMENT_1, address(token), 100 ether);
    }

    // ─── Withdraw Tests (with mock verifier) ─────────────────────

    function test_withdraw_full() public {
        // Deposit first
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        uint256 root = pool.getLastRoot();

        // Withdraw full amount (newCommitment = 0 means no change)
        uint[2] memory proofA = [uint(0), uint(0)];
        uint[2][2] memory proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
        uint[2] memory proofC = [uint(0), uint(0)];

        pool.withdraw(
            proofA, proofB, proofC,
            root,
            NULLIFIER_1,
            0, // no change commitment
            address(token),
            100 ether,
            alice,
            address(0) // no relayer
        );

        assertEq(token.balanceOf(alice), 1000 ether, "alice should get tokens back");
        assertEq(token.balanceOf(address(pool)), 0, "pool should be empty");
        assertTrue(pool.nullifiers(NULLIFIER_1), "nullifier should be spent");
    }

    function test_withdraw_partial_creates_change() public {
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        uint256 root = pool.getLastRoot();
        uint32 indexBefore = pool.nextIndex();

        uint[2] memory proofA;
        uint[2][2] memory proofB;
        uint[2] memory proofC;

        pool.withdraw(
            proofA, proofB, proofC,
            root,
            NULLIFIER_1,
            COMMITMENT_2, // change commitment
            address(token),
            60 ether,
            alice,
            address(0)
        );

        assertEq(token.balanceOf(alice), 960 ether);
        assertEq(token.balanceOf(address(pool)), 40 ether);
        assertEq(pool.nextIndex(), indexBefore + 1, "change commitment should be inserted");
    }

    function test_withdraw_double_spend_reverts() public {
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        uint256 root = pool.getLastRoot();
        uint[2] memory proofA;
        uint[2][2] memory proofB;
        uint[2] memory proofC;

        pool.withdraw(proofA, proofB, proofC, root, NULLIFIER_1, 0, address(token), 100 ether, alice, address(0));

        // Try to double-spend with same nullifier
        vm.expectRevert(CommitmentPool.NullifierAlreadySpent.selector);
        pool.withdraw(proofA, proofB, proofC, root, NULLIFIER_1, 0, address(token), 100 ether, alice, address(0));
    }

    function test_withdraw_unknown_root_reverts() public {
        uint[2] memory proofA;
        uint[2][2] memory proofB;
        uint[2] memory proofC;

        vm.expectRevert(CommitmentPool.UnknownRoot.selector);
        pool.withdraw(proofA, proofB, proofC, 0x999, NULLIFIER_1, 0, address(token), 100 ether, alice, address(0));
    }

    function test_withdraw_invalid_proof_reverts() public {
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        uint256 root = pool.getLastRoot();
        verifier.setShouldPass(false);

        uint[2] memory proofA;
        uint[2][2] memory proofB;
        uint[2] memory proofC;

        vm.expectRevert(CommitmentPool.InvalidProof.selector);
        pool.withdraw(proofA, proofB, proofC, root, NULLIFIER_1, 0, address(token), 100 ether, alice, address(0));
    }

    function test_withdraw_when_paused_reverts() public {
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        pool.pause();
        uint256 root = pool.getLastRoot();

        uint[2] memory proofA;
        uint[2][2] memory proofB;
        uint[2] memory proofC;

        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        pool.withdraw(proofA, proofB, proofC, root, NULLIFIER_1, 0, address(token), 100 ether, alice, address(0));
    }

    function test_withdraw_emits_event() public {
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 100 ether);

        uint256 root = pool.getLastRoot();
        uint[2] memory proofA;
        uint[2][2] memory proofB;
        uint[2] memory proofC;

        vm.expectEmit(true, false, false, true);
        emit CommitmentPool.Withdrawal(alice, NULLIFIER_1, 0, 100 ether);

        pool.withdraw(proofA, proofB, proofC, root, NULLIFIER_1, 0, address(token), 100 ether, alice, address(0));
    }

    // ─── Merkle Tree Tests ───────────────────────────────────────

    function test_root_history() public {
        uint256 root0 = pool.getLastRoot();

        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 50 ether);
        uint256 root1 = pool.getLastRoot();

        vm.prank(bob);
        _deposit(COMMITMENT_2, address(token), 50 ether);
        uint256 root2 = pool.getLastRoot();

        // All roots should be known
        assertTrue(pool.isKnownRoot(root0));
        assertTrue(pool.isKnownRoot(root1));
        assertTrue(pool.isKnownRoot(root2));

        // All roots should be different
        assertTrue(root0 != root1);
        assertTrue(root1 != root2);
    }

    // ─── Admin Tests ─────────────────────────────────────────────

    function test_only_owner_can_pause() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.pause();
    }

    function test_only_owner_can_whitelist() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.setTokenWhitelist(address(token), false);
    }

    // ─── Admin Branch Coverage ───────────────────────────────────

    function test_renounceOwnership_disabled() public {
        vm.expectRevert(CommitmentPool.RenounceOwnershipDisabled.selector);
        pool.renounceOwnership();
    }

    function test_transferOwnership_zero_reverts() public {
        vm.expectRevert(CommitmentPool.ZeroAddress.selector);
        pool.transferOwnership(address(0));
    }

    function test_setTokenWhitelist_zero_reverts() public {
        vm.expectRevert(CommitmentPool.ZeroAddress.selector);
        pool.setTokenWhitelist(address(0), true);
    }

    function test_setSanctionsList_eoa_reverts() public {
        vm.expectRevert(CommitmentPool.NotAContract.selector);
        pool.setSanctionsList(alice);
    }

    function test_setSanctionsList_zero_disables() public {
        // Zero is the documented disable path; verify the state actually clears.
        // (setUp does not wire a sanctions list, so set one first.)
        pool.setSanctionsList(address(new MockToken()));
        pool.setSanctionsList(address(0));
        assertEq(address(pool.sanctionsList()), address(0));
    }

    // ─── Settlement Timelock Branch Coverage ────────────────────

    function test_setAuthorizedSettlement_alreadySet_reverts() public {
        // setUp() leaves authorizedSettlement unset; first call must succeed,
        // second call must hit the SettlementAlreadySet guard.
        address mockSettlement = address(new MockToken());
        pool.setAuthorizedSettlement(mockSettlement);
        vm.expectRevert(CommitmentPool.SettlementAlreadySet.selector);
        pool.setAuthorizedSettlement(mockSettlement);
    }

    function test_setAuthorizedSettlement_zero_reverts() public {
        vm.expectRevert(CommitmentPool.ZeroAddress.selector);
        pool.setAuthorizedSettlement(address(0));
    }

    function test_setAuthorizedSettlement_eoa_reverts() public {
        vm.expectRevert(CommitmentPool.NotAContract.selector);
        pool.setAuthorizedSettlement(alice);
    }

    function test_queueSetAuthorizedSettlement_zero_reverts() public {
        vm.expectRevert(CommitmentPool.ZeroAddress.selector);
        pool.queueSetAuthorizedSettlement(address(0));
    }

    function test_queueSetAuthorizedSettlement_eoa_reverts() public {
        vm.expectRevert(CommitmentPool.NotAContract.selector);
        pool.queueSetAuthorizedSettlement(alice);
    }

    function test_activateAuthorizedSettlement_noPending_reverts() public {
        vm.expectRevert(CommitmentPool.NoPendingSettlement.selector);
        pool.activateAuthorizedSettlement();
    }

    function test_activateAuthorizedSettlement_timelockNotExpired_reverts() public {
        address mockSettlement = address(new MockToken());
        pool.queueSetAuthorizedSettlement(mockSettlement);
        vm.expectRevert(CommitmentPool.TimelockNotExpired.selector);
        pool.activateAuthorizedSettlement();
    }

    function test_queueAndActivate_settlement_succeeds() public {
        address mockSettlement = address(new MockToken());
        pool.queueSetAuthorizedSettlement(mockSettlement);
        vm.warp(block.timestamp + pool.SETTLEMENT_TIMELOCK() + 1);
        pool.activateAuthorizedSettlement();
        assertEq(pool.authorizedSettlement(), mockSettlement);
    }

    // ─── Pause Branch Coverage ──────────────────────────────────

    function test_unpause_restores_deposits() public {
        pool.pause();
        pool.unpause();
        vm.prank(alice);
        _deposit(COMMITMENT_1, address(token), 50 ether);
        assertEq(token.balanceOf(address(pool)), 50 ether);
    }

    function test_only_owner_can_unpause() public {
        pool.pause();
        vm.prank(alice);
        vm.expectRevert();
        pool.unpause();
    }

    // ─── Withdraw Guard Branch Coverage ─────────────────────────

    function test_withdrawFor_unauthorized_reverts() public {
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.NotAuthorizedSettlement.selector);
        pool.withdrawFor(pa, pb, pc, 0, NULLIFIER_1, 0, address(token), 1 ether, bob, address(0));
    }
}
