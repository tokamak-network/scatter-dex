// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";

contract RelayerRegistryTest is Test {
    RelayerRegistry public registry;
    address treasury = address(0x7777);
    address relayer1 = address(0xA1);
    address relayer2 = address(0xA2);

    function setUp() public {
        registry = new RelayerRegistry(treasury);
        vm.deal(relayer1, 10 ether);
        vm.deal(relayer2, 10 ether);
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
        vm.expectRevert(RelayerRegistry.NotOwner.selector);
        registry.setTreasury(address(0x9999));
    }

    function test_constructor_zero_treasury_reverts() public {
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        new RelayerRegistry(address(0));
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
        vm.expectRevert(RelayerRegistry.NotPendingOwner.selector);
        registry.acceptOwnership();
    }
}
