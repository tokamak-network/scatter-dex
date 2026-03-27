// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Realistic mock that mirrors zk-X509 IdentityRegistry behavior.
contract RealisticIdentityRegistry is IIdentityRegistry {
    mapping(address => uint64) private _verifiedUntil;
    bool private _paused;

    function setVerifiedUntil(address user, uint64 expiry) external {
        _verifiedUntil[user] = expiry;
    }

    function setPaused(bool paused_) external {
        _paused = paused_;
    }

    function isVerified(address user) external view override returns (bool) {
        return _verifiedUntil[user] >= block.timestamp;
    }

    function verifiedUntil(address user) external view override returns (uint64) {
        return _verifiedUntil[user];
    }

    function paused() external view override returns (bool) {
        return _paused;
    }
}

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract IdentityGateTest is Test {
    RealisticIdentityRegistry public registry;
    IdentityGate public gate;
    ScatterSettlement public settlement;
    MockToken public token;

    address user1 = address(0x1111);
    address user2 = address(0x2222);
    address unverified = address(0x3333);

    function setUp() public {
        registry = new RealisticIdentityRegistry();
        gate = new IdentityGate(address(registry));
        settlement = new ScatterSettlement(address(gate));
        token = new MockToken();

        // user1: verified until 30 days from now
        registry.setVerifiedUntil(user1, uint64(block.timestamp + 30 days));

        // user2: verified until 1 hour from now (about to expire)
        registry.setVerifiedUntil(user2, uint64(block.timestamp + 1 hours));

        // unverified: never set (verifiedUntil = 0)

        // Setup token approvals
        token.mint(user1, 100e18);
        token.mint(user2, 100e18);
        token.mint(unverified, 100e18);
        vm.prank(user1);
        token.approve(address(settlement), type(uint256).max);
        vm.prank(user2);
        token.approve(address(settlement), type(uint256).max);
        vm.prank(unverified);
        token.approve(address(settlement), type(uint256).max);
    }

    // ─── IdentityGate Unit Tests ─────────────────────────────────

    function test_constructor_zero_address_reverts() public {
        vm.expectRevert(IdentityGate.RegistryAddressZero.selector);
        new IdentityGate(address(0));
    }

    function test_isVerified_active() public view {
        assertTrue(gate.isVerified(user1));
    }

    function test_isVerified_unverified() public view {
        assertFalse(gate.isVerified(unverified));
    }

    function test_isVerified_expired() public {
        // Fast forward past user2's expiry
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));
    }

    function test_verifiedUntil_returns_expiry() public view {
        uint64 expiry = gate.verifiedUntil(user1);
        assertEq(expiry, uint64(block.timestamp + 30 days));
    }

    function test_verifiedUntil_unverified_returns_zero() public view {
        assertEq(gate.verifiedUntil(unverified), 0);
    }

    function test_registry_address() public view {
        assertEq(address(gate.registry()), address(registry));
    }

    // ─── Integration: IdentityGate + ScatterSettlement ───────────

    function test_deposit_verified_user() public {
        vm.prank(user1);
        settlement.deposit(address(token), 10e18);
        assertEq(settlement.deposits(user1, address(token)), 10e18);
    }

    function test_deposit_unverified_reverts() public {
        vm.prank(unverified);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        settlement.deposit(address(token), 10e18);
    }

    function test_deposit_expired_user_reverts() public {
        // user2 is valid now
        vm.prank(user2);
        settlement.deposit(address(token), 5e18);
        assertEq(settlement.deposits(user2, address(token)), 5e18);

        // Fast forward past expiry
        vm.warp(block.timestamp + 2 hours);

        // Now user2 is expired — deposit should fail
        vm.prank(user2);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        settlement.deposit(address(token), 5e18);
    }

    function test_withdraw_still_works_after_expiry() public {
        // Deposit while verified
        vm.prank(user2);
        settlement.deposit(address(token), 10e18);

        // Expire
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));

        // Withdraw should still work (no identity check on withdraw)
        vm.prank(user2);
        settlement.withdraw(address(token), 10e18);
        assertEq(token.balanceOf(user2), 100e18);
    }
}
