// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {BatchAuthorizeVerifier} from "../src/zk/BatchAuthorizeVerifier.sol";
import {BatchAuthorizeVerifier64} from "../src/zk/BatchAuthorizeVerifier_64.sol";
import {BatchAuthorizeVerifier128} from "../src/zk/BatchAuthorizeVerifier_128.sol";

/// @notice Deploy the tier 16/64/128 BatchAuthorizeVerifier contracts and wire
///         them into PrivateSettlement via `setBatchAuthorizeVerifier`, enabling
///         the batched 5-pairing (8→5) optimisation for same-tier `settleAuth`.
///
///  Reversible: `setBatchAuthorizeVerifier(tier, address(0))` disables a tier
///  and falls back to per-side verification.
///
///  These verifiers need via-ir, so run under the batch-verifier profile:
///    FOUNDRY_PROFILE=batch-verifier forge script \
///      script/WireBatchVerifiers.s.sol:WireBatchVerifiers --rpc-url sepolia --broadcast
///
///  Signing: `DEPLOYER_KEY` — MUST be the PrivateSettlement owner (onlyOwner).
///
///  NOTE: the batch verifiers are hand-written assembly; a dedicated security
///  review is recommended before enabling on mainnet. On testnet this validates
///  the live batch path end-to-end.
contract WireBatchVerifiers is Script {
    /// @dev Sepolia PrivateSettlement proxy (contracts/deployments/11155111.json).
    address internal constant SEPOLIA_PROXY = 0x9aA6CFc593aa76DD76015eB4752A05f3A78EA7a8;

    function run() external {
        address proxy = vm.envOr("PRIVATE_SETTLEMENT_PROXY", SEPOLIA_PROXY);
        require(proxy.code.length != 0, "WireBatchVerifiers: proxy has no code");
        PrivateSettlement settlement = PrivateSettlement(payable(proxy));

        // Signing: env key (B) if DEPLOYER_KEY is set, else CLI keystore (A) via
        // `--account` (mirrors DeploySepolia — don't force a raw key in the env).
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", uint256(0));
        address signer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;
        // setBatchAuthorizeVerifier is onlyOwner — fail up front if the signer
        // isn't the owner, before paying to deploy three verifiers.
        require(settlement.owner() == signer, "WireBatchVerifiers: signer not owner");

        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }
        address v16 = address(new BatchAuthorizeVerifier());
        address v64 = address(new BatchAuthorizeVerifier64());
        address v128 = address(new BatchAuthorizeVerifier128());
        settlement.setBatchAuthorizeVerifier(16, v16);
        settlement.setBatchAuthorizeVerifier(64, v64);
        settlement.setBatchAuthorizeVerifier(128, v128);
        vm.stopBroadcast();

        // Post-conditions: the registry now points at the new verifiers.
        require(address(settlement.batchAuthorizeVerifierByTier(16)) == v16, "wire 16 failed");
        require(address(settlement.batchAuthorizeVerifierByTier(64)) == v64, "wire 64 failed");
        require(address(settlement.batchAuthorizeVerifierByTier(128)) == v128, "wire 128 failed");

        console.log("PrivateSettlement:        ", proxy);
        console.log("BatchAuthorizeVerifier16: ", v16);
        console.log("BatchAuthorizeVerifier64: ", v64);
        console.log("BatchAuthorizeVerifier128:", v128);
        console.log("-> add batchAuthorizeVerifier{16,64,128} to deployments/11155111.json");
    }
}
