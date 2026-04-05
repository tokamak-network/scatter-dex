// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract CommitmentPoolTest is Test {
    CommitmentPool public pool;
    MockVerifier public verifier;
    MockToken public token;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant COMMITMENT_1 = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    uint256 constant COMMITMENT_2 = 0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321;
    uint256 constant NULLIFIER_1 = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
    uint256 constant NULLIFIER_2 = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;

    function setUp() public {
        verifier = new MockVerifier();
        pool = new CommitmentPool(address(verifier), 20, 30);
        token = new MockToken();

        pool.setTokenWhitelist(address(token), true);

        token.mint(alice, 1000 ether);
        token.mint(bob, 1000 ether);

        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        token.approve(address(pool), type(uint256).max);
    }

    // ─── Deposit Tests ───────────────────────────────────────────

    function test_deposit() public {
        vm.prank(alice);
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

        assertEq(token.balanceOf(address(pool)), 100 ether);
        assertEq(token.balanceOf(alice), 900 ether);
        assertEq(pool.nextIndex(), 1);
    }

    function test_deposit_updates_root() public {
        uint256 rootBefore = pool.getLastRoot();

        vm.prank(alice);
        pool.deposit(COMMITMENT_1, address(token), 50 ether);

        uint256 rootAfter = pool.getLastRoot();
        assertTrue(rootBefore != rootAfter, "root should change after deposit");
        assertTrue(pool.isKnownRoot(rootAfter), "new root should be known");
    }

    function test_deposit_multiple() public {
        vm.prank(alice);
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

        vm.prank(bob);
        pool.deposit(COMMITMENT_2, address(token), 200 ether);

        assertEq(pool.nextIndex(), 2);
        assertEq(token.balanceOf(address(pool)), 300 ether);
    }

    function test_deposit_emits_event() public {
        vm.expectEmit(true, false, false, true);
        emit CommitmentPool.CommitmentInserted(COMMITMENT_1, 0, block.timestamp);

        vm.prank(alice);
        pool.deposit(COMMITMENT_1, address(token), 100 ether);
    }

    function test_deposit_zero_amount_reverts() public {
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.ZeroAmount.selector);
        pool.deposit(COMMITMENT_1, address(token), 0);
    }

    function test_deposit_zero_commitment_reverts() public {
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.ZeroCommitment.selector);
        pool.deposit(0, address(token), 100 ether);
    }

    function test_deposit_unwhitelisted_token_reverts() public {
        MockToken badToken = new MockToken();
        badToken.mint(alice, 100 ether);

        vm.prank(alice);
        vm.expectRevert(CommitmentPool.TokenNotWhitelisted.selector);
        pool.deposit(COMMITMENT_1, address(badToken), 100 ether);
    }

    function test_deposit_when_paused_reverts() public {
        pool.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(CommitmentPool.ContractPaused.selector);
        pool.deposit(COMMITMENT_1, address(token), 100 ether);
    }

    // ─── Withdraw Tests (with mock verifier) ─────────────────────

    function test_withdraw_full() public {
        // Deposit first
        vm.prank(alice);
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

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
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

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
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

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
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

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
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

        pool.setPaused(true);
        uint256 root = pool.getLastRoot();

        uint[2] memory proofA;
        uint[2][2] memory proofB;
        uint[2] memory proofC;

        vm.expectRevert(CommitmentPool.ContractPaused.selector);
        pool.withdraw(proofA, proofB, proofC, root, NULLIFIER_1, 0, address(token), 100 ether, alice, address(0));
    }

    function test_withdraw_emits_event() public {
        vm.prank(alice);
        pool.deposit(COMMITMENT_1, address(token), 100 ether);

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
        pool.deposit(COMMITMENT_1, address(token), 50 ether);
        uint256 root1 = pool.getLastRoot();

        vm.prank(bob);
        pool.deposit(COMMITMENT_2, address(token), 50 ether);
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
        pool.setPaused(true);
    }

    function test_only_owner_can_whitelist() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.setTokenWhitelist(address(token), false);
    }
}
