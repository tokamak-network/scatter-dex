// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

/// @dev Helpers for exercising a proxy upgrade in tests. The auto-created
///      `ProxyAdmin` isn't exposed by `TransparentUpgradeableProxy`, so we
///      read it from the ERC1967 admin slot and call `upgradeAndCall` as
///      the admin's owner.
library UpgradeHelper {
    Vm constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev ERC1967 admin slot: bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1).
    bytes32 constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    function getProxyAdmin(address proxy) internal view returns (ProxyAdmin) {
        return ProxyAdmin(address(uint160(uint256(VM.load(proxy, ADMIN_SLOT)))));
    }

    /// @dev Upgrade `proxy` to `newImpl` via its auto-created ProxyAdmin.
    ///      `adminOwner` is the address that owns the ProxyAdmin (the
    ///      `proxyAdminOwner` passed to `ProxyDeployer.deployX`).
    function upgrade(address proxy, address newImpl, address adminOwner) internal {
        ProxyAdmin admin = getProxyAdmin(proxy);
        VM.prank(adminOwner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), newImpl, "");
    }
}
