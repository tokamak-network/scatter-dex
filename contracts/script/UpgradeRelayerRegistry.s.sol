// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";

/// @notice Upgrade the RelayerRegistry proxy to the combined admin-config impl:
///         configurable bond token (`setBondToken` + per-relayer
///         `Relayer.bondToken`) and configurable exit cooldown (`setExitCooldown`
///         + storage `exitCooldown`). Storage layout is append-only.
///
///  The upgrade is performed via `upgradeAndCall(..., reinitializeV2())` so the
///  two new storage fields are initialized ATOMICALLY with the implementation
///  swap — there's no block where `exitCooldown` reads 0 (which would let
///  relayers skip the cooldown) or an existing relayer's `bondToken` reads 0
///  (which would mis-handle their bond as native). `reinitializeV2` is guarded by
///  OZ `reinitializer(2)`, so it runs exactly once.
///
///  Signing: `DEPLOYER_KEY` — must be the ProxyAdmin owner (`UPGRADE_OWNER`,
///  the same 0xc1eba383… deploy key, kept in gitignored contracts/.env).
///
///  Run:
///    forge script script/UpgradeRelayerRegistry.s.sol:UpgradeRelayerRegistry \
///      --rpc-url sepolia --broadcast
contract UpgradeRelayerRegistry is Script {
    /// @dev Sepolia RelayerRegistry proxy (contracts/deployments/11155111.json).
    ///      Override with the RELAYER_REGISTRY_PROXY env var for other chains.
    address internal constant SEPOLIA_PROXY = 0x38066496C050e8F45f5454a40d38797ED68dF826;

    function run() external {
        address proxy = vm.envOr("RELAYER_REGISTRY_PROXY", SEPOLIA_PROXY);

        // The transparent proxy doesn't expose its ProxyAdmin; read it from the
        // ERC1967 admin slot (mirrors test/upgrade/UpgradeHelper.sol).
        ProxyAdmin admin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));

        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        RelayerRegistry newImpl = new RelayerRegistry();
        admin.upgradeAndCall(
            ITransparentUpgradeableProxy(proxy),
            address(newImpl),
            abi.encodeCall(RelayerRegistry.reinitializeV2, ())
        );
        vm.stopBroadcast();

        console.log("RelayerRegistry proxy:    ", proxy);
        console.log("ProxyAdmin:               ", address(admin));
        console.log("New RelayerRegistry impl: ", address(newImpl));
        console.log("-> update deployments/11155111.json `relayerRegistryImpl` to the new impl.");
    }
}
