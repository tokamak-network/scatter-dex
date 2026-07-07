// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {FeeVault} from "../src/FeeVault.sol";

/// @notice Upgrade the FeeVault proxy to the impl that makes the platform
///         fee-change timelock delay admin-configurable (`setFeeChangeDelay` +
///         storage `feeChangeDelay`, replacing the `FEE_CHANGE_DELAY` constant).
///         Storage layout is append-only (`feeChangeDelay` consumes one __gap
///         slot).
///
///  Performed via `upgradeAndCall(..., reinitializeFeeChangeDelay())` so the new
///  `feeChangeDelay` field is set to the default ATOMICALLY with the impl swap —
///  otherwise it would read 0, making `scheduleFeeChange` apply with no timelock
///  (removing the front-running protection on relayer claims). Guarded by OZ
///  `reinitializer(2)`, so it runs exactly once.
///
///  Signing: `DEPLOYER_KEY` — must be the ProxyAdmin owner (`UPGRADE_OWNER`,
///  the 0xc1eba383… deploy key, in gitignored contracts/.env).
///
///  Run:
///    forge script script/UpgradeFeeVault.s.sol:UpgradeFeeVault \
///      --rpc-url sepolia --broadcast
contract UpgradeFeeVault is Script {
    /// @dev Sepolia FeeVault proxy (contracts/deployments/11155111.json).
    ///      Override with the FEE_VAULT_PROXY env var for other chains.
    address internal constant SEPOLIA_PROXY = 0xC0E66b179753C26b9e2874639142F082c2d33A4e;

    function run() external {
        address proxy = vm.envOr("FEE_VAULT_PROXY", SEPOLIA_PROXY);

        ProxyAdmin admin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));

        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        FeeVault newImpl = new FeeVault();
        admin.upgradeAndCall(
            ITransparentUpgradeableProxy(proxy),
            address(newImpl),
            abi.encodeCall(FeeVault.reinitializeFeeChangeDelay, ())
        );
        vm.stopBroadcast();

        console.log("FeeVault proxy:    ", proxy);
        console.log("ProxyAdmin:        ", address(admin));
        console.log("New FeeVault impl: ", address(newImpl));
        console.log("-> update deployments/11155111.json `feeVaultImpl` to the new impl.");
    }
}
