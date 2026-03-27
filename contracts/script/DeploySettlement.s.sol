// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";

/// @notice Deploys IdentityGate + RelayerRegistry + ScatterSettlement.
/// @dev Usage:
///   IDENTITY_REGISTRY=0x... TREASURY=0x... PROTOCOL_FEE_BPS=1000 \
///   forge script script/DeploySettlement.s.sol \
///     --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract DeploySettlement is Script {
    function run() external {
        address registryAddr = vm.envAddress("IDENTITY_REGISTRY");
        address treasuryAddr = vm.envAddress("TREASURY");
        uint256 protocolFeeBps = vm.envUint("PROTOCOL_FEE_BPS");

        vm.startBroadcast();

        IdentityGate gate = new IdentityGate(registryAddr);
        console.log("IdentityGate deployed:", address(gate));

        RelayerRegistry relayerRegistry = new RelayerRegistry(treasuryAddr);
        console.log("RelayerRegistry deployed:", address(relayerRegistry));

        ScatterSettlement settlement = new ScatterSettlement(
            address(gate), address(relayerRegistry), protocolFeeBps
        );
        console.log("ScatterSettlement deployed:", address(settlement));

        vm.stopBroadcast();
    }
}
