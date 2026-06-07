// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {SharedAdminProxy} from "../src/proxy/SharedAdminProxy.sol";

/// @dev Minimal logic contracts to exercise the proxy.
contract ImplV1 {
    // No-op init so the proxy is constructed with non-empty data — this OZ
    // ERC1967Proxy reverts (ERC1967ProxyUninitialized) on empty construction
    // data; production proxies always pass an `initialize(...)` call.
    function initialize() external {}

    function version() external pure returns (uint256) {
        return 1;
    }
}

contract ImplV2 {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @notice Behavioural tests for {SharedAdminProxy}: it must behave exactly like
///         a transparent proxy whose admin is an externally-supplied, SHARED
///         {ProxyAdmin} — upgradeable only via that admin, never falling through
///         admin calls to the implementation, and refusing an EOA admin.
contract SharedAdminProxyTest is Test {
    address internal owner = address(0xA11CE);
    ProxyAdmin internal admin;
    SharedAdminProxy internal proxy;
    ImplV1 internal v1;

    function setUp() public {
        admin = new ProxyAdmin(owner);
        v1 = new ImplV1();
        proxy = new SharedAdminProxy(address(v1), address(admin), abi.encodeCall(ImplV1.initialize, ()));
    }

    /// The injected admin MUST be a contract — an EOA admin would lock the proxy.
    function test_constructor_revertsOnEoaAdmin() public {
        ImplV1 impl = new ImplV1();
        vm.expectRevert(SharedAdminProxy.AdminNotAContract.selector);
        new SharedAdminProxy(address(impl), address(0xBEEF), abi.encodeCall(ImplV1.initialize, ()));
    }

    /// The ERC-1967 admin slot is set to the shared ProxyAdmin (not a fresh one).
    function test_adminSlotIsTheSharedProxyAdmin() public view {
        address slotAdmin =
            address(uint160(uint256(vm.load(address(proxy), ERC1967Utils.ADMIN_SLOT))));
        assertEq(slotAdmin, address(admin), "admin slot != shared ProxyAdmin");
    }

    /// Normal callers fall through to the implementation.
    function test_callPassesThroughToImpl() public view {
        assertEq(ImplV1(address(proxy)).version(), 1);
    }

    /// The shared ProxyAdmin's owner can upgrade the proxy.
    function test_ownerCanUpgradeViaSharedAdmin() public {
        ImplV2 v2 = new ImplV2();
        vm.prank(owner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), address(v2), "");
        assertEq(ImplV1(address(proxy)).version(), 2, "upgrade did not take effect");
    }

    /// A single ProxyAdmin can govern multiple SharedAdminProxy instances, and
    /// one ownership transfer hands off all of them at once.
    function test_oneAdminGovernsManyProxies_andTransfersTogether() public {
        SharedAdminProxy proxy2 = new SharedAdminProxy(address(v1), address(admin), abi.encodeCall(ImplV1.initialize, ()));
        ImplV2 v2 = new ImplV2();

        address newOwner = address(0xB0B);
        vm.prank(owner);
        admin.transferOwnership(newOwner);

        // Old owner can no longer upgrade either proxy.
        vm.prank(owner);
        vm.expectRevert();
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), address(v2), "");

        // New owner upgrades both through the same admin.
        vm.startPrank(newOwner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), address(v2), "");
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy2)), address(v2), "");
        vm.stopPrank();
        assertEq(ImplV1(address(proxy)).version(), 2);
        assertEq(ImplV1(address(proxy2)).version(), 2);
    }

    /// Non-owners cannot upgrade (ProxyAdmin is Ownable).
    function test_nonOwnerCannotUpgrade() public {
        ImplV2 v2 = new ImplV2();
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(proxy)), address(v2), "");
    }

    /// The admin itself cannot fall through to the implementation — any non-
    /// upgrade call from the admin reverts (transparent-proxy guarantee).
    function test_adminCannotFallThroughToImpl() public {
        vm.prank(address(admin));
        vm.expectRevert(SharedAdminProxy.ProxyDeniedAdminAccess.selector);
        ImplV1(address(proxy)).version();
    }
}
