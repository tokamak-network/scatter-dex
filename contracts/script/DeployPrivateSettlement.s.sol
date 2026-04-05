// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";

/// @notice Deploy ZK private settlement contracts for local testing.
/// @dev Run after DeployLocal.s.sol. Requires verifier contracts to be deployed first.
///      Usage: forge script script/DeployPrivateSettlement.s.sol --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployPrivateSettlement is Script {
    function run() external {
        vm.startBroadcast();

        // 1. Deploy verifiers (Groth16 auto-generated contracts)
        // These are deployed as regular contracts — no constructor args
        address withdrawVerifier = _deployContract("WithdrawVerifier.sol:Groth16Verifier");
        console.log("WithdrawVerifier:", withdrawVerifier);

        address settleVerifier = _deployContract("SettleVerifier.sol:Groth16Verifier");
        console.log("SettleVerifier:", settleVerifier);

        address claimVerifier = _deployContract("ClaimVerifier.sol:Groth16Verifier");
        console.log("ClaimVerifier:", claimVerifier);

        // 2. Deploy CommitmentPool (ZK escrow)
        //    depth=20 (1M leaves), rootHistorySize=30
        CommitmentPool pool = new CommitmentPool(withdrawVerifier, 20, 30);
        console.log("CommitmentPool:", address(pool));

        // 3. Deploy PrivateSettlement
        PrivateSettlement settlement = new PrivateSettlement(
            address(pool), settleVerifier, claimVerifier
        );
        console.log("PrivateSettlement:", address(settlement));

        // 4. Authorize settlement to insert commitments into pool
        pool.setAuthorizedSettlement(address(settlement));
        console.log("Authorized PrivateSettlement on CommitmentPool");

        // 5. Whitelist tokens (use same WETH/USDC as DeployLocal)
        // These addresses are deterministic from DeployLocal on anvil
        address weth = 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9;
        address usdc = 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707;

        pool.setTokenWhitelist(weth, true);
        pool.setTokenWhitelist(usdc, true);
        settlement.setTokenWhitelist(weth, true);
        settlement.setTokenWhitelist(usdc, true);
        console.log("Whitelisted WETH and USDC on pool and settlement");

        vm.stopBroadcast();

        console.log("");
        console.log("=== ZK PRIVATE SETTLEMENT DEPLOYED ===");
        console.log(string.concat("NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=", vm.toString(address(pool))));
        console.log(string.concat("NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=", vm.toString(address(settlement))));
    }

    function _deployContract(string memory what) internal returns (address addr) {
        bytes memory bytecode = vm.getCode(what);
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "deploy failed");
    }
}
