// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract MockRelayerIdentityRegistry is IIdentityRegistry {
    mapping(address => bool) public verified;

    function setVerified(address user, bool status) external {
        verified[user] = status;
    }

    function isVerified(address user) external view override returns (bool) {
        return verified[user];
    }

    function verifiedUntil(address) external pure override returns (uint64) {
        return type(uint64).max;
    }

    function paused() external pure override returns (bool) {
        return false;
    }
}

contract RelayerRegistryTest is Test {
    RelayerRegistry public registry;
    MockRelayerIdentityRegistry public identityRegistry;
    address treasury = address(0x7777);
    address relayer1 = address(0xA1);
    address relayer2 = address(0xA2);

    function setUp() public {
        identityRegistry = new MockRelayerIdentityRegistry();
        registry = new RelayerRegistry(treasury, address(identityRegistry));
        vm.deal(relayer1, 10 ether);
        vm.deal(relayer2, 10 ether);
        // Verify relayers by default so existing tests pass
        identityRegistry.setVerified(relayer1, true);
        identityRegistry.setVerified(relayer2, true);
    }

    // ─── Registration ────────────────────────────────────────────

    function test_register() public {
        vm.prank(relayer1);
        registry.register{value: 0.5 ether}("http://relay1.com", 30);

        assertTrue(registry.isActiveRelayer(relayer1));
        (string memory url, uint256 fee, uint256 bond,, uint256 exitAt, bool active) = registry.relayers(relayer1);
        assertEq(url, "http://relay1.com");
        assertEq(fee, 30);
        assertEq(bond, 0.5 ether);
        assertEq(exitAt, 0);
        assertTrue(active);
        assertEq(registry.getRelayerCount(), 1);
    }

    function test_register_min_bond() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
        assertTrue(registry.isActiveRelayer(relayer1));
    }

    function test_register_insufficient_bond_reverts() public {
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.InsufficientBond.selector);
        registry.register{value: 0.05 ether}("http://relay1.com", 30);
    }

    function test_register_already_registered_reverts() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);

        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.AlreadyRegistered.selector);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
    }

    // ─── Update ──────────────────────────────────────────────────

    function test_updateInfo() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://old.com", 30);

        vm.prank(relayer1);
        registry.updateInfo("http://new.com", 20);

        (string memory url, uint256 fee,,,,) = registry.relayers(relayer1);
        assertEq(url, "http://new.com");
        assertEq(fee, 20);
    }

    function test_updateInfo_while_exiting_reverts() public {
        vm.startPrank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
        registry.requestExit();

        vm.expectRevert(RelayerRegistry.AlreadyExiting.selector);
        registry.updateInfo("http://new.com", 20);
        vm.stopPrank();
    }

    function test_addBond() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);

        vm.prank(relayer1);
        registry.addBond{value: 0.5 ether}();

        (,, uint256 bond,,,) = registry.relayers(relayer1);
        assertEq(bond, 0.6 ether);
    }

    // ─── Exit ────────────────────────────────────────────────────

    function test_exit_flow() public {
        vm.prank(relayer1);
        registry.register{value: 1 ether}("http://relay1.com", 30);

        // Request exit
        vm.prank(relayer1);
        registry.requestExit();

        // Still active but exiting
        assertFalse(registry.isActiveRelayer(relayer1));

        // Can't exit before cooldown
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.CooldownNotPassed.selector);
        registry.executeExit();

        // Wait cooldown
        vm.warp(block.timestamp + 7 days);

        uint256 balBefore = relayer1.balance;
        vm.prank(relayer1);
        registry.executeExit();

        assertEq(relayer1.balance, balBefore + 1 ether);
        assertFalse(registry.isActiveRelayer(relayer1));
    }

    function test_requestExit_not_registered_reverts() public {
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.NotRegistered.selector);
        registry.requestExit();
    }

    function test_requestExit_already_exiting_reverts() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);

        vm.prank(relayer1);
        registry.requestExit();

        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.AlreadyExiting.selector);
        registry.requestExit();
    }

    // ─── Views ───────────────────────────────────────────────────

    function test_getActiveRelayers() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
        vm.prank(relayer2);
        registry.register{value: 0.1 ether}("http://relay2.com", 20);

        address[] memory active = registry.getActiveRelayers();
        assertEq(active.length, 2);

        // relayer1 exits
        vm.prank(relayer1);
        registry.requestExit();

        active = registry.getActiveRelayers();
        assertEq(active.length, 1);
        assertEq(active[0], relayer2);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function test_setTreasury() public {
        address newTreasury = address(0x9999);
        registry.setTreasury(newTreasury);
        assertEq(registry.treasury(), newTreasury);
    }

    function test_setTreasury_not_owner_reverts() public {
        vm.prank(relayer1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer1));
        registry.setTreasury(address(0x9999));
    }

    function test_constructor_zero_treasury_reverts() public {
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        new RelayerRegistry(address(0), address(identityRegistry));
    }

    function test_constructor_zero_identity_registry_reverts() public {
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        new RelayerRegistry(treasury, address(0));
    }

    function test_register_unverified_reverts() public {
        address unverified = address(0xBEEF);
        vm.deal(unverified, 10 ether);
        // NOT calling identityRegistry.setVerified(unverified, true)
        vm.prank(unverified);
        vm.expectRevert(RelayerRegistry.NotVerified.selector);
        registry.register{value: 0.1 ether}("http://unverified.com", 30);
    }

    function test_register_fee_too_high_reverts() public {
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.FeeTooHigh.selector);
        registry.register{value: 0.1 ether}("http://example.com", 501);
    }

    function test_register_fee_at_max_succeeds() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://example.com", 500);
        assertTrue(registry.isActiveRelayer(relayer1));
    }

    function test_updateInfo_fee_too_high_reverts() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.FeeTooHigh.selector);
        registry.updateInfo("http://new.url", 501);
    }

    function test_updateInfo_fee_at_max_succeeds() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
        vm.prank(relayer1);
        registry.updateInfo("http://new.url", 500);
        (,uint256 fee,,,,) = registry.relayers(relayer1);
        assertEq(fee, 500);
    }

    function test_getFee() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
        assertEq(registry.getFee(relayer1), 30);
    }

    function test_addBond_zero_reverts() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", 30);
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.InsufficientBond.selector);
        registry.addBond{value: 0}();
    }

    function test_transferOwnership_two_step() public {
        address newOwner = address(0x9999);
        registry.transferOwnership(newOwner);
        // Owner not changed yet
        assertEq(registry.owner(), address(this));
        assertEq(registry.pendingOwner(), newOwner);

        vm.prank(newOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), newOwner);
        assertEq(registry.pendingOwner(), address(0));
    }

    function test_acceptOwnership_not_pending_reverts() public {
        registry.transferOwnership(address(0x9999));
        vm.prank(relayer1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer1));
        registry.acceptOwnership();
    }

    function test_renounceOwnership_reverts() public {
        vm.expectRevert(RelayerRegistry.RenounceOwnershipDisabled.selector);
        registry.renounceOwnership();
    }

    function test_transferOwnership_zero_address_reverts() public {
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        registry.transferOwnership(address(0));
    }
}
