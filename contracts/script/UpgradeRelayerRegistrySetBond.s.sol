// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";

/// @notice Upgrade the RelayerRegistry proxy to the impl that adds the atomic
///         `setBond(token, minBond)` setter.
///
///  This is a FUNCTION-ONLY change — no new storage, no struct change. So the
///  upgrade is a plain re-point with EMPTY init data: no reinitializer is run
///  (and none could be — the proxy already consumed `reinitializer(2)` in the
///  bond-token + exit-cooldown upgrade; calling it again would revert).
///
///  Signing: `DEPLOYER_KEY` — must be the ProxyAdmin owner (`UPGRADE_OWNER`,
///  the 0xc1eba383… deploy key, in gitignored contracts/.env).
///
///  Run:
///    forge script script/UpgradeRelayerRegistrySetBond.s.sol:UpgradeRelayerRegistrySetBond \
///      --rpc-url sepolia --broadcast
contract UpgradeRelayerRegistrySetBond is Script {
    /// @dev Sepolia RelayerRegistry proxy (contracts/deployments/11155111.json).
    ///      Override with the RELAYER_REGISTRY_PROXY env var for other chains.
    address internal constant SEPOLIA_PROXY = 0x38066496C050e8F45f5454a40d38797ED68dF826;

    function run() external {
        address proxy = vm.envOr("RELAYER_REGISTRY_PROXY", SEPOLIA_PROXY);

        ProxyAdmin admin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));

        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        RelayerRegistry newImpl = new RelayerRegistry();
        admin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(newImpl), ""); // plain, no reinit
        vm.stopBroadcast();

        console.log("RelayerRegistry proxy:    ", proxy);
        console.log("ProxyAdmin:               ", address(admin));
        console.log("New RelayerRegistry impl: ", address(newImpl));
        console.log("-> update deployments/11155111.json `relayerRegistryImpl` to the new impl.");
    }
}
