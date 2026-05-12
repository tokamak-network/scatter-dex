// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

/// @dev Helpers for exercising a proxy upgrade in tests. The auto-created
///      `ProxyAdmin` isn't exposed by `TransparentUpgradeableProxy`, so we
///      read it from the ERC1967 admin slot and call `upgradeAndCall` as
///      the admin's owner.
library UpgradeHelper {
    Vm constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function getProxyAdmin(address proxy) internal view returns (ProxyAdmin) {
        return ProxyAdmin(address(uint160(uint256(VM.load(proxy, ERC1967Utils.ADMIN_SLOT)))));
    }

    /// @dev Upgrade `proxy` to `newImpl` via its auto-created ProxyAdmin.
    ///      `adminOwner` is the address that owns the ProxyAdmin (the
    ///      `proxyAdminOwner` passed to `ProxyDeployer.deployX`).
    function upgrade(address proxy, address newImpl, address adminOwner) internal {
        upgradeAndCall(proxy, newImpl, adminOwner, "");
    }

    /// @dev Upgrade + delegatecall arbitrary init data on the new impl. Used to
    ///      exercise `reinitializer(N)` paths during the upgrade.
    function upgradeAndCall(address proxy, address newImpl, address adminOwner, bytes memory data) internal {
        ProxyAdmin admin = getProxyAdmin(proxy);
        VM.prank(adminOwner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), newImpl, data);
    }
}
