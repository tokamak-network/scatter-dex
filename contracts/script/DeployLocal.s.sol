// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockToken} from "./DeployTestTokens.s.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";

/// @dev Mock identity registry that verifies everyone (for local testing)
contract MockIdentityRegistry is IIdentityRegistry {
    function isVerified(address) external pure override returns (bool) { return true; }
    function verifiedUntil(address) external pure override returns (uint64) { return type(uint64).max; }
    function paused() external pure override returns (bool) { return false; }
}

/// @notice Deploy everything for local E2E testing on anvil.
/// @dev Usage: forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployLocal is Script {
    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        vm.startBroadcast(deployerKey);
        address deployer = msg.sender;

        // 1. Identity registries (Dual-CA: User CA + Relayer CA)
        //    If IDENTITY_REGISTRY env is set, use real registries (integration mode).
        //    Otherwise, deploy mocks (standalone mock mode).
        address userRegistry = vm.envOr("IDENTITY_REGISTRY", address(0));
        address relayerRegistry_ = vm.envOr("RELAYER_IDENTITY_REGISTRY", address(0));

        if (userRegistry == address(0)) {
            userRegistry = address(new MockIdentityRegistry());
            console.log("MockIdentityRegistry (User CA):", userRegistry);
        } else {
            console.log("IdentityRegistry (User CA):", userRegistry);
        }

        if (relayerRegistry_ == address(0)) {
            relayerRegistry_ = address(new MockIdentityRegistry());
            console.log("MockIdentityRegistry (Relayer CA):", relayerRegistry_);
        } else {
            console.log("IdentityRegistry (Relayer CA):", relayerRegistry_);
        }

        // 2. Identity gate (User CA)
        IdentityGate gate = new IdentityGate(userRegistry);
        console.log("IdentityGate:", address(gate));

        // 3. Relayer registry (Relayer CA)
        RelayerRegistry relayerRegistry = new RelayerRegistry(deployer, relayerRegistry_);
        console.log("RelayerRegistry:", address(relayerRegistry));

        // 4. Mock tokens (WETH with deposit/withdraw, USDC as plain ERC20)
        MockWETH weth = new MockWETH();
        MockToken usdc = new MockToken("USD Coin", "USDC");
        console.log("WETH:", address(weth));
        console.log("USDC:", address(usdc));

        // 5. Mint tokens to anvil default accounts
        address alice = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil #0
        address bob = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;   // anvil #1

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(bob, 1_000_000e18);
        console.log("Minted USDC to Alice and Bob");

        // 6. Register zk-relayer (anvil Account #1)
        // WARNING: Anvil default key — NEVER use in production
        uint256 zkRelayerKey = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        vm.stopBroadcast();
        vm.startBroadcast(zkRelayerKey);
        relayerRegistry.register("http://localhost:3002", 30);
        console.log("Account #1 registered as zk-relayer");
        vm.stopBroadcast();
        vm.startBroadcast(deployerKey);

        // ── ZK Private Settlement ────────────────────────────────

        // 7-9. Deploy verifiers, CommitmentPool, and PrivateSettlement.
        //      Extracted into a helper to avoid "stack too deep".
        (CommitmentPool pool, PrivateSettlement privateSettlement) = _deployZkCore(address(weth));

        // 10. Authorize + whitelist
        pool.setAuthorizedSettlement(address(privateSettlement));
        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        privateSettlement.setTokenWhitelist(address(weth), true);
        privateSettlement.setTokenWhitelist(address(usdc), true);

        // 11. Deploy FeeVault (5% platform fee, treasury = deployer)
        FeeVault vault = new FeeVault(deployer, 500);
        vault.setAuthorizedDepositor(address(privateSettlement), true);
        console.log("FeeVault:", address(vault));

        // 12. Wire relayer registry + fee vault to PrivateSettlement
        privateSettlement.setRelayerRegistry(address(relayerRegistry));
        privateSettlement.setFeeVault(address(vault));

        // 13. Whitelist DEX routers for settleWithDex (market orders)
        //     1inch Aggregation Router V6 — same address on all EVM chains
        address ONEINCH_ROUTER = 0x111111125421cA6dc452d289314280a0f8842A65;
        if (ONEINCH_ROUTER.code.length > 0) {
            privateSettlement.setDexRouterWhitelist(ONEINCH_ROUTER, true);
            console.log("1inch Router whitelisted:", ONEINCH_ROUTER);
        } else {
            console.log("1inch Router not deployed on this chain (skipped)");
        }
        console.log("ZK contracts configured (relayer gate + fee vault + DEX routers)");

        vm.stopBroadcast();

        // Print summary
        console.log("");
        console.log("=== LOCAL DEPLOYMENT SUMMARY ===");
        console.log(string.concat("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=", vm.toString(address(relayerRegistry))));
        console.log(string.concat("NEXT_PUBLIC_WETH_ADDRESS=", vm.toString(address(weth))));
        console.log(string.concat("NEXT_PUBLIC_TOKENS=", vm.toString(address(weth)), ":WETH:18,", vm.toString(address(usdc)), ":USDC:18"));
        console.log(string.concat("NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=", vm.toString(address(pool))));
        console.log(string.concat("NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=", vm.toString(address(privateSettlement))));
        console.log(string.concat("NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=", vm.toString(address(gate))));
        console.log(string.concat("NEXT_PUBLIC_RPC_URL=http://localhost:8545"));
        console.log(string.concat("NEXT_PUBLIC_CHAIN_ID=", vm.toString(block.chainid)));
        console.log(string.concat("NEXT_PUBLIC_FEE_VAULT_ADDRESS=", vm.toString(address(vault))));
        console.log(string.concat("NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002"));
    }

    function _deployCode(string memory what) internal returns (address addr) {
        bytes memory bytecode = vm.getCode(what);
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "deploy failed");
    }

    /// @dev Deploy verifiers + CommitmentPool + PrivateSettlement.
    ///      Extracted into its own function to avoid "stack too deep" in run().
    function _deployZkCore(address weth)
        internal
        returns (CommitmentPool pool, PrivateSettlement privateSettlement)
    {
        address withdrawVerifier = _deployCode("WithdrawVerifier.sol:Groth16Verifier");
        address settleVerifier = _deployCode("SettleVerifier.sol:Groth16Verifier");
        address claimVerifier = _deployCode("ClaimVerifier.sol:Groth16Verifier");
        address depositVerifier = _deployCode("DepositVerifier.sol:Groth16Verifier");
        console.log("WithdrawVerifier:", withdrawVerifier);
        console.log("SettleVerifier:", settleVerifier);
        console.log("ClaimVerifier:", claimVerifier);
        console.log("DepositVerifier:", depositVerifier);

        pool = new CommitmentPool(withdrawVerifier, depositVerifier, 20, 30);
        console.log("CommitmentPool:", address(pool));

        privateSettlement = new PrivateSettlement(
            address(pool), settleVerifier, claimVerifier, weth
        );
        console.log("PrivateSettlement:", address(privateSettlement));
    }
}
