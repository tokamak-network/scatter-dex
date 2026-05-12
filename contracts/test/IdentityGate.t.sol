// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

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
    RealisticIdentityRegistry public registry1;
    RealisticIdentityRegistry public registry2;
    IdentityGate public gate;

    address user1 = address(0x1111);
    address user2 = address(0x2222);
    address user3 = address(0x3333);
    address unverified = address(0x4444);

    function setUp() public {
        registry1 = new RealisticIdentityRegistry();
        registry2 = new RealisticIdentityRegistry();
        gate = ProxyDeployer.deployIdentityGate(address(this), address(this), address(registry1));

        // user1: verified in registry1 (30 days)
        registry1.setVerifiedUntil(user1, uint64(block.timestamp + 30 days));

        // user2: verified in registry1 (1 hour — about to expire)
        registry1.setVerifiedUntil(user2, uint64(block.timestamp + 1 hours));

        // user3: verified in registry2 only (not yet added to gate)
        registry2.setVerifiedUntil(user3, uint64(block.timestamp + 60 days));
    }

    // ─── Initializer ─────────────────────────────────────────

    function test_initialize_zero_registry_reverts() public {
        IdentityGate impl = new IdentityGate();
        bytes memory initData = abi.encodeCall(IdentityGate.initialize, (address(this), address(0)));
        vm.expectRevert(IdentityGate.RegistryAddressZero.selector);
        new TransparentUpgradeableProxy(address(impl), address(this), initData);
    }

    function test_initialize_sets_initial_registry() public view {
        assertEq(gate.getRegistryCount(), 1);
        assertEq(address(gate.registries(0)), address(registry1));
    }

    // ─── Single Registry ─────────────────────────────────────

    function test_isVerified_active() public view {
        assertTrue(gate.isVerified(user1));
    }

    function test_isVerified_unverified() public view {
        assertFalse(gate.isVerified(unverified));
    }

    function test_isVerified_expired() public {
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));
    }

    function test_verifiedUntil_returns_expiry() public view {
        assertEq(gate.verifiedUntil(user1), uint64(block.timestamp + 30 days));
    }

    function test_verifiedUntil_unverified_returns_zero() public view {
        assertEq(gate.verifiedUntil(unverified), 0);
    }

    function test_isVerified_paused() public {
        assertTrue(gate.isVerified(user1));
        registry1.setPaused(true);
        assertFalse(gate.isVerified(user1));
    }

    // ─── Multi-CA Registry Management ────────────────────────

    function test_addRegistry() public {
        gate.addRegistry(address(registry2));
        assertEq(gate.getRegistryCount(), 2);
        assertTrue(gate.registryExists(address(registry2)));
    }

    function test_addRegistry_not_owner_reverts() public {
        vm.prank(user1);
        vm.expectRevert();
        gate.addRegistry(address(registry2));
    }

    function test_addRegistry_zero_address_reverts() public {
        vm.expectRevert(IdentityGate.RegistryAddressZero.selector);
        gate.addRegistry(address(0));
    }

    function test_addRegistry_duplicate_reverts() public {
        vm.expectRevert(IdentityGate.RegistryAlreadyAdded.selector);
        gate.addRegistry(address(registry1));
    }

    function test_removeRegistry() public {
        gate.addRegistry(address(registry2));
        gate.removeRegistry(address(registry1));
        assertEq(gate.getRegistryCount(), 1);
        assertFalse(gate.registryExists(address(registry1)));
    }

    function test_removeRegistry_last_one_reverts() public {
        vm.expectRevert(IdentityGate.NoRegistries.selector);
        gate.removeRegistry(address(registry1));
    }

    function test_removeRegistry_not_found_reverts() public {
        vm.expectRevert(IdentityGate.RegistryNotFound.selector);
        gate.removeRegistry(address(registry2));
    }

    function test_getRegistries() public {
        gate.addRegistry(address(registry2));
        address[] memory addrs = gate.getRegistries();
        assertEq(addrs.length, 2);
        assertEq(addrs[0], address(registry1));
        assertEq(addrs[1], address(registry2));
    }

    // ─── Multi-CA Verification ───────────────────────────────

    function test_multiCA_user_verified_in_second_registry() public {
        // user3 is only in registry2 — not verified yet
        assertFalse(gate.isVerified(user3));

        // Add registry2
        gate.addRegistry(address(registry2));

        // Now user3 is verified
        assertTrue(gate.isVerified(user3));
    }

    function test_multiCA_verifiedUntil_returns_latest() public {
        // user1: 30 days in registry1
        // Add user1 to registry2 with 60 days
        registry2.setVerifiedUntil(user1, uint64(block.timestamp + 60 days));
        gate.addRegistry(address(registry2));

        // Should return the later expiry (60 days)
        assertEq(gate.verifiedUntil(user1), uint64(block.timestamp + 60 days));
    }

    function test_multiCA_one_paused_returns_paused() public {
        gate.addRegistry(address(registry2));
        assertFalse(gate.paused());

        registry1.setPaused(true);
        assertTrue(gate.paused());
    }

    function test_multiCA_paused_registry_skipped_for_verification() public {
        // user1 in registry1, user3 in registry2
        gate.addRegistry(address(registry2));
        assertTrue(gate.isVerified(user1));
        assertTrue(gate.isVerified(user3));

        // Pause registry1 — user1 loses verification, user3 still OK
        registry1.setPaused(true);
        assertFalse(gate.isVerified(user1));
        assertTrue(gate.isVerified(user3));
    }

    function test_reverify_after_expiry() public {
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));

        registry1.setVerifiedUntil(user2, uint64(block.timestamp + 30 days));
        assertTrue(gate.isVerified(user2));
    }

    // ─── Ownership ───────────────────────────────────────────

    function test_renounce_ownership_reverts() public {
        vm.expectRevert(IdentityGate.RenounceOwnershipDisabled.selector);
        gate.renounceOwnership();
    }
}
