// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";

/// @notice Deploys IdentityGate + RelayerRegistry + ScatterSettlement.
/// @dev Usage:
///   IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... \
///   TREASURY=0x... PROTOCOL_FEE_BPS=1000 \
///   forge script script/DeploySettlement.s.sol \
///     --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract DeploySettlement is Script {
    function run() external {
        address registryAddr = vm.envAddress("IDENTITY_REGISTRY");
        require(registryAddr != address(0), "DeploySettlement: IDENTITY_REGISTRY not set or is address(0)");
        address relayerIdentityRegistryAddr = vm.envAddress("RELAYER_IDENTITY_REGISTRY");
        require(relayerIdentityRegistryAddr != address(0), "DeploySettlement: RELAYER_IDENTITY_REGISTRY not set or is address(0)");
        address treasuryAddr = vm.envAddress("TREASURY");
        require(treasuryAddr != address(0), "DeploySettlement: TREASURY not set or is address(0)");
        uint256 protocolFeeBps = vm.envUint("PROTOCOL_FEE_BPS");
        require(protocolFeeBps <= 10000, "DeploySettlement: PROTOCOL_FEE_BPS exceeds 100%");

        vm.startBroadcast();

        IdentityGate gate = new IdentityGate(registryAddr);
        console.log("IdentityGate deployed:", address(gate));

        RelayerRegistry relayerRegistry = new RelayerRegistry(treasuryAddr, relayerIdentityRegistryAddr);
        console.log("RelayerRegistry deployed:", address(relayerRegistry));

        ScatterSettlement settlement = new ScatterSettlement(
            address(gate), address(relayerRegistry), protocolFeeBps
        );
        console.log("ScatterSettlement deployed:", address(settlement));

        vm.stopBroadcast();
    }
}
