// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";

/// @notice Deploys IdentityGate + ScatterSettlement against an existing IdentityRegistry.
/// @dev Usage:
///   IDENTITY_REGISTRY=0x... forge script script/DeploySettlement.s.sol \
///     --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract DeploySettlement is Script {
    function run() external {
        address registryAddr = vm.envAddress("IDENTITY_REGISTRY");
        require(registryAddr != address(0), "DeploySettlement: IDENTITY_REGISTRY env var not set or is address(0)");

        vm.startBroadcast();

        IdentityGate gate = new IdentityGate(registryAddr);
        console.log("IdentityGate deployed:", address(gate));

        ScatterSettlement settlement = new ScatterSettlement(address(gate));
        console.log("ScatterSettlement deployed:", address(settlement));

        vm.stopBroadcast();
    }
}
