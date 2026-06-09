// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";

/// @notice Upgrade the RelayerRegistry proxy to a new implementation that adds
///         the configurable bond token (owner `setBondToken` + per-relayer
///         `Relayer.bondToken` recording). Storage layout is append-only (a new
///         member on the `Relayer` struct, which is only a mapping value).
///
///  Signing: `DEPLOYER_KEY` — must be the ProxyAdmin owner (`UPGRADE_OWNER`,
///  the same 0xc1eba383… deploy key, kept in gitignored contracts/.env).
///
///  Run:
///    forge script script/UpgradeRelayerRegistry.s.sol:UpgradeRelayerRegistry \
///      --rpc-url sepolia --broadcast
///
///  No reinitializer is shipped: `getRelayerCount()` is 0 on Sepolia (verified),
///  so the new per-relayer `bondToken` field simply starts recording from the
///  first registration. The run reverts if that precondition no longer holds —
///  a non-empty registry would need a backfill reinitializer first (existing
///  bonds were in the single deploy-time token, which the new field would
///  otherwise read as `address(0)`=native).
contract UpgradeRelayerRegistry is Script {
    /// @dev Sepolia RelayerRegistry proxy (contracts/deployments/11155111.json).
    ///      Override with the RELAYER_REGISTRY_PROXY env var for other chains.
    address internal constant SEPOLIA_PROXY = 0x64fd8485793717fa3aBdb1FFc3406eC7fEee08fD;

    function run() external {
        address proxy = vm.envOr("RELAYER_REGISTRY_PROXY", SEPOLIA_PROXY);

        // The transparent proxy doesn't expose its ProxyAdmin; read it from the
        // ERC1967 admin slot (mirrors test/upgrade/UpgradeHelper.sol).
        ProxyAdmin admin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));

        // Migration guard — see the no-reinitializer note above.
        uint256 count = RelayerRegistry(payable(proxy)).getRelayerCount();
        require(count == 0, "relayers exist: add a bondToken backfill reinitializer before upgrading");

        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        RelayerRegistry newImpl = new RelayerRegistry();
        admin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(newImpl), "");
        vm.stopBroadcast();

        console.log("RelayerRegistry proxy:    ", proxy);
        console.log("ProxyAdmin:               ", address(admin));
        console.log("New RelayerRegistry impl: ", address(newImpl));
        console.log("-> update deployments/11155111.json `relayerRegistryImpl` to the new impl.");
    }
}
