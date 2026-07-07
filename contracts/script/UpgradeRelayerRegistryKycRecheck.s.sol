// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";

/// @notice Upgrade the RelayerRegistry proxy to the audit B-1/B-2 implementation:
///         continuous (operational) KYC enforcement (`operationalKycRequired` +
///         `setOperationalKycRequired`, re-checked in `_isOperational`) and
///         fee-on-transfer-safe bond accounting (`_pullBond` records the measured
///         balance delta). Storage layout is append-only (one new `bool` after
///         `exitCooldown`, one `__gap` slot consumed).
///
///  Unlike `UpgradeRelayerRegistry` (bond-token + exit-cooldown), this upgrade is a
///  PLAIN implementation swap with NO reinitializer: the only new storage field,
///  `operationalKycRequired`, reads its zero value `false`, which is exactly the
///  intended default (legacy register-time-only KYC gate preserved). There is no
///  window of wrong behaviour, so `upgradeAndCall` is called with empty data.
///
///  Enabling continuous enforcement is a SEPARATE owner action AFTER the upgrade:
///    registry.setKycApprovalRegistry(<IssuanceApprovalRegistry>)  // if not wired
///    registry.setOperationalKycRequired(true)
///
///  Signing: `DEPLOYER_KEY` — must be the ProxyAdmin owner (`UPGRADE_OWNER`,
///  the same 0xc1eba383… deploy key, kept in gitignored contracts/.env).
///
///  Run:
///    forge script script/UpgradeRelayerRegistryKycRecheck.s.sol:UpgradeRelayerRegistryKycRecheck \
///      --rpc-url sepolia --broadcast
contract UpgradeRelayerRegistryKycRecheck is Script {
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
        // Empty calldata → no reinitializer; `operationalKycRequired` defaults false.
        admin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(newImpl), "");
        vm.stopBroadcast();

        console.log("RelayerRegistry proxy:    ", proxy);
        console.log("ProxyAdmin:               ", address(admin));
        console.log("New RelayerRegistry impl: ", address(newImpl));
        console.log("-> update deployments/11155111.json `relayerRegistryImpl` to the new impl.");
        console.log("-> to enable continuous KYC: setKycApprovalRegistry(...) then setOperationalKycRequired(true).");
    }
}
