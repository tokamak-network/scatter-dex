// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockKycApproval} from "./mocks/MockKycApproval.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract RelayerRegistryTest is Test {
    RelayerRegistry public registry;
    MockIdentityRegistry public identityRegistry;
    MockKycApproval public kycApproval;
    address treasury = address(0x7777);
    address relayer1 = address(0xA1);
    address relayer2 = address(0xA2);

    function setUp() public {
        identityRegistry = new MockIdentityRegistry();
        // KYC-approval mock is created but left UNWIRED by default
        // (kycApprovalRegistry stays address(0)), so the AND gate is off
        // and every pre-existing test keeps its zk-X509-only behaviour.
        kycApproval = new MockKycApproval();
        registry = ProxyDeployer.deployRelayerRegistry(
            address(this), address(this), treasury, address(identityRegistry), address(0)
        );
        vm.deal(relayer1, 10 ether);
        vm.deal(relayer2, 10 ether);
        // Verify relayers by default so existing tests pass
        identityRegistry.setVerified(relayer1, true);
        identityRegistry.setVerified(relayer2, true);
    }

    // ─── Registration ────────────────────────────────────────────

    function test_register() public {
        vm.prank(relayer1);
        registry.register{value: 0.5 ether}("http://relay1.com", "Relayer-test", 30, 0);

        assertTrue(registry.isActiveRelayer(relayer1));
        (string memory url,, uint256 fee, uint256 bond,, uint256 exitAt, bool active) = registry.relayers(relayer1);
        assertEq(url, "http://relay1.com");
        assertEq(fee, 30);
        assertEq(bond, 0.5 ether);
        assertEq(exitAt, 0);
        assertTrue(active);
        assertEq(registry.getRelayerCount(), 1);
    }

    function test_register_zero_bond_when_optional() public {
        // Default minBond = 0 → bond is optional
        vm.prank(relayer1);
        registry.register("http://relay1.com", "Relayer-test", 30, 0);
        assertTrue(registry.isActiveRelayer(relayer1));
    }

    function test_register_insufficient_bond_reverts_when_set() public {
        registry.setMinBond(0.1 ether);
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.InsufficientBond.selector);
        registry.register{value: 0.05 ether}("http://relay1.com", "Relayer-test", 30, 0);
    }

    function test_setMinBond() public {
        registry.setMinBond(1 ether);
        assertEq(registry.minBond(), 1 ether);
    }

    function test_setMinBond_not_owner_reverts() public {
        vm.prank(relayer1);
        vm.expectRevert();
        registry.setMinBond(1 ether);
    }

    function test_register_already_registered_reverts() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);

        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.AlreadyRegistered.selector);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
    }

    // ─── Update ──────────────────────────────────────────────────

    function test_updateInfo() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://old.com", "Relayer-test", 30, 0);

        vm.prank(relayer1);
        registry.updateInfo("http://new.com", "Relayer-test", 20);

        (string memory url,, uint256 fee,,,,) = registry.relayers(relayer1);
        assertEq(url, "http://new.com");
        assertEq(fee, 20);
    }

    function test_updateInfo_while_exiting_reverts() public {
        vm.startPrank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
        registry.requestExit();

        vm.expectRevert(RelayerRegistry.AlreadyExiting.selector);
        registry.updateInfo("http://new.com", "Relayer-test", 20);
        vm.stopPrank();
    }

    function test_addBond() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);

        vm.prank(relayer1);
        registry.addBond{value: 0.5 ether}(0);

        (,,, uint256 bond,,,) = registry.relayers(relayer1);
        assertEq(bond, 0.6 ether);
    }

    // ─── Exit ────────────────────────────────────────────────────

    function test_exit_flow() public {
        vm.prank(relayer1);
        registry.register{value: 1 ether}("http://relay1.com", "Relayer-test", 30, 0);

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
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);

        vm.prank(relayer1);
        registry.requestExit();

        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.AlreadyExiting.selector);
        registry.requestExit();
    }

    // ─── Views ───────────────────────────────────────────────────

    function test_getActiveRelayers() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
        vm.prank(relayer2);
        registry.register{value: 0.1 ether}("http://relay2.com", "Relayer-test", 20, 0);

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

    function test_setIdentityRegistry() public {
        MockIdentityRegistry newRegistry = new MockIdentityRegistry();
        // IdentityRegistryUpdated has no indexed params; check data only.
        vm.expectEmit(false, false, false, true);
        emit RelayerRegistry.IdentityRegistryUpdated(address(identityRegistry), address(newRegistry));
        registry.setIdentityRegistry(address(newRegistry));
        assertEq(address(registry.identityRegistry()), address(newRegistry));
    }

    function test_setIdentityRegistry_not_owner_reverts() public {
        MockIdentityRegistry newRegistry = new MockIdentityRegistry();
        vm.prank(relayer1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer1));
        registry.setIdentityRegistry(address(newRegistry));
    }

    function test_setIdentityRegistry_zero_reverts() public {
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        registry.setIdentityRegistry(address(0));
    }

    function test_setIdentityRegistry_preserves_existing_relayers() public {
        // Register relayer1 under the original (verified-all) registry, then
        // swap to a registry that returns false for everyone. The existing
        // relayer stays active — proving the swap only gates future
        // register() calls, not previously-seated operators.
        vm.prank(relayer1);
        registry.register("http://relay1", "Relayer-1", 30, 0);
        assertTrue(registry.isActiveRelayer(relayer1));

        MockIdentityRegistry rejectAll = new MockIdentityRegistry();
        registry.setIdentityRegistry(address(rejectAll));
        assertTrue(registry.isActiveRelayer(relayer1));

        // A fresh wallet that isn't in the new registry cannot register.
        address newcomer = address(0xCAFE);
        vm.deal(newcomer, 10 ether);
        vm.prank(newcomer);
        vm.expectRevert(RelayerRegistry.NotVerified.selector);
        registry.register("http://newcomer", "Newcomer", 25, 0);
    }

    // ─── KYC AND gate (feature-flagged) ─────────────────────────

    function test_register_kyc_gate_disabled_by_default() public {
        // No KYC registry wired → gate off → verified relayer registers fine.
        assertEq(address(registry.kycApprovalRegistry()), address(0));
        vm.prank(relayer1);
        registry.register("http://relay1.com", "Relayer-1", 30, 0);
        assertTrue(registry.isActiveRelayer(relayer1));
    }

    function test_register_kyc_gate_on_not_approved_reverts() public {
        registry.setKycApprovalRegistry(address(kycApproval));
        // relayer1 is zk-X509 verified (setUp) but NOT KYC-approved.
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.NotKycApproved.selector);
        registry.register("http://relay1.com", "Relayer-1", 30, 0);
    }

    function test_register_kyc_gate_on_approved_succeeds() public {
        registry.setKycApprovalRegistry(address(kycApproval));
        kycApproval.setApproved(relayer1, true);
        // Both gates satisfied: zk-X509 verified AND KYC approved.
        vm.prank(relayer1);
        registry.register("http://relay1.com", "Relayer-1", 30, 0);
        assertTrue(registry.isActiveRelayer(relayer1));
    }

    function test_register_kyc_gate_on_approved_but_unverified_blocks_on_identity_leg() public {
        // Sanity: with the gate on, a KYC-approved-but-unverified wallet is
        // still blocked by the zk-X509 leg — the gate is an AND, not an OR.
        registry.setKycApprovalRegistry(address(kycApproval));
        address ghost = address(0xBEEF);
        vm.deal(ghost, 10 ether);
        kycApproval.setApproved(ghost, true); // approved but never zk-X509 verified
        vm.prank(ghost);
        vm.expectRevert(RelayerRegistry.NotVerified.selector);
        registry.register("http://ghost.com", "Ghost", 30, 0);
    }

    function test_setKycApprovalRegistry() public {
        vm.expectEmit(false, false, false, true);
        emit RelayerRegistry.KycApprovalRegistryUpdated(address(0), address(kycApproval));
        registry.setKycApprovalRegistry(address(kycApproval));
        assertEq(address(registry.kycApprovalRegistry()), address(kycApproval));
    }

    function test_setKycApprovalRegistry_not_owner_reverts() public {
        vm.prank(relayer1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer1));
        registry.setKycApprovalRegistry(address(kycApproval));
    }

    function test_setKycApprovalRegistry_zero_disables_gate() public {
        // Enable, then clear back to address(0): registration falls back to
        // zk-X509-only. address(0) is a valid input (the feature-flag "off").
        registry.setKycApprovalRegistry(address(kycApproval));
        registry.setKycApprovalRegistry(address(0));
        assertEq(address(registry.kycApprovalRegistry()), address(0));
        vm.prank(relayer1); // verified, not KYC-approved — should still pass
        registry.register("http://relay1.com", "Relayer-1", 30, 0);
        assertTrue(registry.isActiveRelayer(relayer1));
    }

    function test_enabling_kyc_gate_preserves_existing_relayers() public {
        // Register relayer1 with the gate off, then enable the gate while
        // relayer1 is NOT KYC-approved. The existing relayer stays active —
        // the gate only applies at register() time (mirrors setIdentityRegistry).
        vm.prank(relayer1);
        registry.register("http://relay1.com", "Relayer-1", 30, 0);
        assertTrue(registry.isActiveRelayer(relayer1));

        registry.setKycApprovalRegistry(address(kycApproval)); // relayer1 unapproved
        assertTrue(registry.isActiveRelayer(relayer1));

        // But a fresh, unapproved-yet-verified wallet is now blocked.
        vm.prank(relayer2);
        vm.expectRevert(RelayerRegistry.NotKycApproved.selector);
        registry.register("http://relay2.com", "Relayer-2", 30, 0);
    }

    function test_initialize_zero_treasury_reverts() public {
        RelayerRegistry impl = new RelayerRegistry();
        bytes memory initData = abi.encodeCall(
            RelayerRegistry.initialize, (address(this), address(0), address(identityRegistry), address(0))
        );
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        new TransparentUpgradeableProxy(address(impl), address(this), initData);
    }

    function test_initialize_zero_identity_registry_reverts() public {
        RelayerRegistry impl = new RelayerRegistry();
        bytes memory initData =
            abi.encodeCall(RelayerRegistry.initialize, (address(this), treasury, address(0), address(0)));
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        new TransparentUpgradeableProxy(address(impl), address(this), initData);
    }

    function test_register_unverified_reverts() public {
        address unverified = address(0xBEEF);
        vm.deal(unverified, 10 ether);
        // NOT calling identityRegistry.setVerified(unverified, true)
        vm.prank(unverified);
        vm.expectRevert(RelayerRegistry.NotVerified.selector);
        registry.register{value: 0.1 ether}("http://unverified.com", "Relayer-test", 30, 0);
    }

    function test_register_fee_too_high_reverts() public {
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.FeeTooHigh.selector);
        registry.register{value: 0.1 ether}("http://example.com", "Relayer-test", 501, 0);
    }

    function test_register_fee_at_max_succeeds() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://example.com", "Relayer-test", 500, 0);
        assertTrue(registry.isActiveRelayer(relayer1));
    }

    function test_updateInfo_fee_too_high_reverts() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.FeeTooHigh.selector);
        registry.updateInfo("http://new.url", "Relayer-test", 501);
    }

    function test_updateInfo_fee_at_max_succeeds() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
        vm.prank(relayer1);
        registry.updateInfo("http://new.url", "Relayer-test", 500);
        (,, uint256 fee,,,,) = registry.relayers(relayer1);
        assertEq(fee, 500);
    }

    function test_getFee() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
        assertEq(registry.getFee(relayer1), 30);
    }

    function test_addBond_zero_reverts() public {
        vm.prank(relayer1);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.InsufficientBond.selector);
        registry.addBond{value: 0}(0);
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

    // ─── Reentrancy ─────────────────────────────────────────────

    function test_executeExit_reentrancy_reverts() public {
        ReentrantRelayer attacker = new ReentrantRelayer(registry, identityRegistry);
        vm.deal(address(attacker), 10 ether);

        attacker.registerAndRequestExit();
        vm.warp(block.timestamp + 7 days);

        vm.expectRevert(RelayerRegistry.BondTransferFailed.selector);
        attacker.attack();
    }
}

/// @dev Malicious contract that attempts to re-register during executeExit callback.
contract ReentrantRelayer {
    RelayerRegistry public registry;
    MockIdentityRegistry public identityRegistry;
    bool private attacking;

    constructor(RelayerRegistry _registry, MockIdentityRegistry _identityRegistry) {
        registry = _registry;
        identityRegistry = _identityRegistry;
        identityRegistry.setVerified(address(this), true);
    }

    function registerAndRequestExit() external {
        registry.register{value: 1 ether}("http://attacker.com", "Relayer-test", 10, 0);
        registry.requestExit();
    }

    function attack() external {
        attacking = true;
        registry.executeExit();
    }

    receive() external payable {
        if (attacking) {
            attacking = false;
            // Re-register to exploit the freed active slot — blocked by nonReentrant
            registry.register{value: msg.value}("http://attacker.com", "Relayer-test", 10, 0);
        }
    }
}

// ─── ERC20-mode tests ──────────────────────────────────────────────

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTON is ERC20 {
    constructor() ERC20("Mock TON", "TON") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RelayerRegistryERC20Test is Test {
    RelayerRegistry public registry;
    MockIdentityRegistry public identityRegistry;
    MockTON public ton;
    address treasury = address(0x7777);
    address relayer1 = address(0xA1);

    function setUp() public {
        identityRegistry = new MockIdentityRegistry();
        ton = new MockTON();
        registry = ProxyDeployer.deployRelayerRegistry(
            address(this), address(this), treasury, address(identityRegistry), address(ton)
        );
        identityRegistry.setVerified(relayer1, true);
        ton.mint(relayer1, 10 ether);
    }

    function test_register_pulls_erc20_bond() public {
        vm.startPrank(relayer1);
        ton.approve(address(registry), 0.5 ether);
        registry.register("http://relay1.com", "Relayer-test", 30, 0.5 ether);
        vm.stopPrank();

        (,,, uint256 bond,,,) = registry.relayers(relayer1);
        assertEq(bond, 0.5 ether);
        assertEq(ton.balanceOf(address(registry)), 0.5 ether);
        assertEq(ton.balanceOf(relayer1), 9.5 ether);
    }

    function test_register_with_native_value_reverts_in_erc20_mode() public {
        vm.deal(relayer1, 1 ether);
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.WrongPaymentMode.selector);
        registry.register{value: 0.1 ether}("http://relay1.com", "Relayer-test", 30, 0);
    }

    function test_register_zero_bond_when_optional_in_erc20_mode() public {
        vm.prank(relayer1);
        registry.register("http://relay1.com", "Relayer-test", 30, 0);
        assertTrue(registry.isActiveRelayer(relayer1));
        (,,, uint256 bond,,,) = registry.relayers(relayer1);
        assertEq(bond, 0);
    }

    function test_register_insufficient_erc20_bond_reverts() public {
        registry.setMinBond(0.5 ether);
        vm.startPrank(relayer1);
        ton.approve(address(registry), 0.1 ether);
        vm.expectRevert(RelayerRegistry.InsufficientBond.selector);
        registry.register("http://relay1.com", "Relayer-test", 30, 0.1 ether);
        vm.stopPrank();
    }

    function test_addBond_pulls_erc20() public {
        vm.startPrank(relayer1);
        ton.approve(address(registry), 0.5 ether);
        registry.register("http://relay1.com", "Relayer-test", 30, 0.5 ether);

        ton.approve(address(registry), 0.3 ether);
        registry.addBond(0.3 ether);
        vm.stopPrank();

        (,,, uint256 bond,,,) = registry.relayers(relayer1);
        assertEq(bond, 0.8 ether);
    }

    function test_addBond_with_native_value_reverts_in_erc20_mode() public {
        vm.startPrank(relayer1);
        ton.approve(address(registry), 0.5 ether);
        registry.register("http://relay1.com", "Relayer-test", 30, 0.5 ether);
        vm.stopPrank();

        vm.deal(relayer1, 1 ether);
        vm.prank(relayer1);
        vm.expectRevert(RelayerRegistry.WrongPaymentMode.selector);
        registry.addBond{value: 0.1 ether}(0);
    }

    function test_executeExit_returns_erc20_bond() public {
        vm.startPrank(relayer1);
        ton.approve(address(registry), 0.5 ether);
        registry.register("http://relay1.com", "Relayer-test", 30, 0.5 ether);
        registry.requestExit();
        vm.warp(block.timestamp + 7 days + 1);
        registry.executeExit();
        vm.stopPrank();

        assertEq(ton.balanceOf(relayer1), 10 ether);
        assertEq(ton.balanceOf(address(registry)), 0);
        (,,, uint256 bond,,, bool active) = registry.relayers(relayer1);
        assertEq(bond, 0);
        assertFalse(active);
    }
}
