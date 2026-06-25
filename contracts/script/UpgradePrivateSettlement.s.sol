// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";

/// @notice Upgrade the PrivateSettlement proxy to the implementation that drops
///         the dead `scatterDirect` path (audit "scatterDirect": withdraw-proof
///         flow left `claimsRoot` unconstrained). The removal deletes only a
///         function, its `ScatterDirectParams` struct, the `ScatterDirect` event,
///         and the now-orphaned `onlyRelayer` modifier / `_routeFeeLocal` helper —
///         NO storage variables change, so the layout is identical and there is
///         nothing to reinitialize.
///
///  This is therefore a PLAIN implementation swap with NO reinitializer (empty
///  calldata). Storage-layout invariance is covered by
///  `test/upgrade/Upgrade.t.sol::test_privateSettlement_upgrade_preservesStateAndAddsV2`.
///
///  Low urgency: `scatterDirect` is already a dead (uncalled) function on-chain,
///  so this is intended to be batched with the RelayerRegistry B-1/B-2 upgrade
///  (`UpgradeRelayerRegistryKycRecheck`) at the operator's chosen time — do NOT
///  broadcast piecemeal.
///
///  Signing: `DEPLOYER_KEY` — must be the ProxyAdmin owner (the deploy key kept in
///  gitignored contracts/.env).
///
///  Run (batch window only):
///    forge script script/UpgradePrivateSettlement.s.sol:UpgradePrivateSettlement \
///      --rpc-url sepolia --broadcast
contract UpgradePrivateSettlement is Script {
    /// @dev Sepolia PrivateSettlement proxy (contracts/deployments/11155111.json).
    ///      Override with the PRIVATE_SETTLEMENT_PROXY env var for other chains.
    address internal constant SEPOLIA_PROXY = 0x9aA6CFc593aa76DD76015eB4752A05f3A78EA7a8;

    function run() external {
        address proxy = vm.envOr("PRIVATE_SETTLEMENT_PROXY", SEPOLIA_PROXY);

        // The transparent proxy doesn't expose its ProxyAdmin; read it from the
        // ERC1967 admin slot (mirrors test/upgrade/UpgradeHelper.sol).
        ProxyAdmin admin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));

        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        PrivateSettlement newImpl = new PrivateSettlement();
        // Empty calldata → no reinitializer; storage layout is unchanged.
        admin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(newImpl), "");
        vm.stopBroadcast();

        console.log("PrivateSettlement proxy:    ", proxy);
        console.log("ProxyAdmin:                 ", address(admin));
        console.log("New PrivateSettlement impl: ", address(newImpl));
        console.log("-> update deployments/11155111.json `privateSettlementImpl` to the new impl.");
    }
}
