// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {SanctionsList} from "../src/SanctionsList.sol";

/// @dev Standalone deploy that only puts SanctionsList behind a proxy.
///      Use when the full DeployLocal pipeline is blocked (e.g. tiered
///      verifier artifacts missing) but admin still needs a sanctions
///      target. The proxy is admin-owned by `msg.sender`, matching the
///      production wiring.
contract DeploySanctionsOnly is Script {
    error WrongNetwork(uint256 chainId);

    function run() external {
        // Refuse to run on anything other than anvil chainIds. The proxy
        // admin and contract owner collapse onto a single EOA here, which
        // is fine for local-only fix-ups but a catastrophic foot-gun if it
        // ever lands on mainnet/testnet — one compromised key would let
        // an attacker both upgrade the impl and clear the sanctions map.
        if (block.chainid != 31337 && block.chainid != 31338) {
            revert WrongNetwork(block.chainid);
        }
        vm.startBroadcast();
        SanctionsList impl = new SanctionsList();
        bytes memory initData = abi.encodeCall(SanctionsList.initialize, (msg.sender));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), msg.sender, initData);
        console.log("SanctionsList impl:", address(impl));
        console.log("SanctionsList proxy:", address(proxy));
        vm.stopBroadcast();
    }
}
