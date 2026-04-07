// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

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
        return !_paused && _verifiedUntil[user] >= block.timestamp;
    }

    function verifiedUntil(address user) external view override returns (uint64) {
        return _verifiedUntil[user];
    }

    function paused() external view override returns (bool) {
        return _paused;
    }
}

contract IdentityGateTest is Test {
    RealisticIdentityRegistry public registry;
    IdentityGate public gate;

    address user1 = address(0x1111);
    address user2 = address(0x2222);
    address unverified = address(0x3333);

    function setUp() public {
        registry = new RealisticIdentityRegistry();
        gate = new IdentityGate(address(registry));

        // user1: verified until 30 days from now
        registry.setVerifiedUntil(user1, uint64(block.timestamp + 30 days));

        // user2: verified until 1 hour from now (about to expire)
        registry.setVerifiedUntil(user2, uint64(block.timestamp + 1 hours));

        // unverified: never set (verifiedUntil = 0)
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

    function test_isVerified_paused() public {
        assertTrue(gate.isVerified(user1));
        registry.setPaused(true);
        assertFalse(gate.isVerified(user1));
    }

    function test_registry_address() public view {
        assertEq(address(gate.registry()), address(registry));
    }

    function test_reverify_after_expiry() public {
        // user2 expires
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));

        // Re-verify with new certificate (new expiry)
        registry.setVerifiedUntil(user2, uint64(block.timestamp + 30 days));
        assertTrue(gate.isVerified(user2));
    }
}
