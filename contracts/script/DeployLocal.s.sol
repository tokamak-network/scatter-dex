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
import {BatchExecutor} from "../src/BatchExecutor.sol";

/// @dev Mock identity registry that verifies everyone (for local testing)
contract MockIdentityRegistry is IIdentityRegistry {
    function isVerified(address) external pure override returns (bool) { return true; }
    function verifiedUntil(address) external pure override returns (uint64) { return type(uint64).max; }
    function paused() external pure override returns (bool) { return false; }
}

/// @notice Deploy everything for local E2E testing on anvil.
/// @dev Usage: forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployLocal is Script {
    // Stored across helper calls so run()'s local variable count stays
    // below the EVM stack-depth limit when assembling the deploy summary.
    address internal _authorizeVerifier;

    struct Deployed {
        address relayerRegistry;
        address weth;
        address usdc;
        uint8 usdcDecimals;
        address usdt;  // 0x0 when not using real tokens
        address wton;  // 0x0 when not using real tokens
        address pool;
        address privateSettlement;
        address gate;
        address vault;
        address batchExecutor;
    }

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
        RelayerRegistry relayerRegistry = new RelayerRegistry(deployer, relayerRegistry_, address(0));
        console.log("RelayerRegistry:", address(relayerRegistry));

        // 4. Tokens — mock by default, or real mainnet addresses when
        //    USE_REAL_TOKENS is set (fork mode). Real tokens are required
        //    for `settleWithDex` to route through actual 1inch / Uniswap
        //    liquidity; mock tokens have no on-chain DEX pools. Extracted
        //    into a helper to keep run()'s stack-depth below the limit.
        bool useRealTokens = vm.envOr("USE_REAL_TOKENS", false);
        (address wethAddr, address usdcAddr, address usdtAddr, address wtonAddr) = _deployOrPickTokens(useRealTokens);

        // 6. Register zk-relayer (anvil Account #1)
        // WARNING: Anvil default key — NEVER use in production
        uint256 zkRelayerKey = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        vm.stopBroadcast();
        vm.startBroadcast(zkRelayerKey);
        relayerRegistry.register("http://localhost:3002", 30, 0);
        console.log("Account #1 registered as zk-relayer");
        vm.stopBroadcast();
        vm.startBroadcast(deployerKey);

        // ── ZK Private Settlement ────────────────────────────────

        // 7-9. Deploy verifiers, CommitmentPool, and PrivateSettlement.
        //      Extracted into a helper to avoid "stack too deep".
        (CommitmentPool pool, PrivateSettlement privateSettlement) = _deployZkCore(wethAddr);

        // 10. Authorize + whitelist
        pool.setAuthorizedSettlement(address(privateSettlement));
        pool.setTokenWhitelist(wethAddr, true);
        pool.setTokenWhitelist(usdcAddr, true);
        privateSettlement.setTokenWhitelist(wethAddr, true);
        privateSettlement.setTokenWhitelist(usdcAddr, true);
        if (useRealTokens) {
            pool.setTokenWhitelist(usdtAddr, true);
            pool.setTokenWhitelist(wtonAddr, true);
            privateSettlement.setTokenWhitelist(usdtAddr, true);
            privateSettlement.setTokenWhitelist(wtonAddr, true);
        }

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
        //     Uniswap V3 SwapRouter02 — frontend fallback when 1inch unavailable
        address UNISWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
        if (UNISWAP_ROUTER02.code.length > 0) {
            privateSettlement.setDexRouterWhitelist(UNISWAP_ROUTER02, true);
            console.log("Uniswap SwapRouter02 whitelisted:", UNISWAP_ROUTER02);
        } else {
            console.log("Uniswap SwapRouter02 not deployed on this chain (skipped)");
        }
        console.log("ZK contracts configured (relayer gate + fee vault + DEX routers)");

        // Deploy the minimal EIP-7702 batch executor. The frontend
        // authorizes EOAs to delegate to this address when available,
        // collapsing deposit's wrap+approve+deposit popups into one tx.
        BatchExecutor batchExecutor = new BatchExecutor();
        console.log("BatchExecutor:", address(batchExecutor));

        vm.stopBroadcast();

        Deployed memory d;
        d.relayerRegistry = address(relayerRegistry);
        d.weth = wethAddr;
        d.usdc = usdcAddr;
        d.usdcDecimals = useRealTokens ? uint8(6) : uint8(18);
        d.usdt = useRealTokens ? usdtAddr : address(0);
        d.wton = useRealTokens ? wtonAddr : address(0);
        d.pool = address(pool);
        d.privateSettlement = address(privateSettlement);
        d.gate = address(gate);
        d.vault = address(vault);
        d.batchExecutor = address(batchExecutor);
        _printSummary(d);
    }

    function _printSummary(Deployed memory d) internal view {
        address relayerRegistry = d.relayerRegistry;
        address weth = d.weth;
        address usdc = d.usdc;
        address pool = d.pool;
        address privateSettlement = d.privateSettlement;
        address gate = d.gate;
        address vault = d.vault;
        address batchExecutor = d.batchExecutor;
        address authorizeVerifier = _authorizeVerifier;
        console.log("");
        console.log("=== LOCAL DEPLOYMENT SUMMARY ===");
        console.log(string.concat("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=", vm.toString(relayerRegistry)));
        console.log(string.concat("NEXT_PUBLIC_WETH_ADDRESS=", vm.toString(weth)));
        string memory tokens = string.concat(
            "NEXT_PUBLIC_TOKENS=", vm.toString(weth), ":WETH:18,",
            vm.toString(usdc), ":USDC:", vm.toString(d.usdcDecimals)
        );
        if (d.usdt != address(0)) {
            tokens = string.concat(tokens, ",", vm.toString(d.usdt), ":USDT:6");
        }
        if (d.wton != address(0)) {
            tokens = string.concat(tokens, ",", vm.toString(d.wton), ":WTON:27");
        }
        console.log(tokens);
        console.log(string.concat("NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=", vm.toString(pool)));
        console.log(string.concat("NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=", vm.toString(privateSettlement)));
        console.log(string.concat("NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=", vm.toString(gate)));
        console.log(string.concat("NEXT_PUBLIC_RPC_URL=http://localhost:8545"));
        console.log(string.concat("NEXT_PUBLIC_CHAIN_ID=", vm.toString(block.chainid)));
        console.log(string.concat("NEXT_PUBLIC_FEE_VAULT_ADDRESS=", vm.toString(vault)));
        console.log(string.concat("NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002"));
        console.log(string.concat("NEXT_PUBLIC_BATCH_EXECUTOR_ADDRESS=", vm.toString(batchExecutor)));
        console.log(string.concat("NEXT_PUBLIC_AUTHORIZE_VERIFIER_ADDRESS=", vm.toString(authorizeVerifier)));
    }

    function _deployCode(string memory what) internal returns (address addr) {
        bytes memory bytecode = vm.getCode(what);
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "deploy failed");
    }

    /// @dev Pick token addresses (real mainnet or freshly-deployed mocks).
    ///      Handles minting for mock mode.
    function _deployOrPickTokens(bool useRealTokens)
        internal
        returns (address weth, address usdc, address usdt, address wton)
    {
        if (useRealTokens) {
            weth = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // mainnet WETH (18)
            usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // mainnet USDC (6)
            usdt = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // mainnet USDT (6)
            wton = 0xc4A11aaf6ea915Ed7Ac194161d2fC9384F15bff2; // Tokamak WTON (27)
            require(weth.code.length > 0, "Real WETH not on chain - are you forking mainnet?");
            require(usdc.code.length > 0, "Real USDC not on chain - are you forking mainnet?");
            require(usdt.code.length > 0, "Real USDT not on chain - are you forking mainnet?");
            require(wton.code.length > 0, "Real WTON not on chain - are you forking mainnet?");
            console.log("WETH:", weth);
            console.log("USDC:", usdc);
            console.log("USDT:", usdt);
            console.log("WTON:", wton);
            console.log("(using real mainnet token addresses)");
        } else {
            MockWETH wethMock = new MockWETH();
            MockToken usdcMock = new MockToken("USD Coin", "USDC");
            weth = address(wethMock);
            usdc = address(usdcMock);
            console.log("WETH:", weth);
            console.log("USDC:", usdc);
            // Mint USDC to anvil default accounts. Real USDC can't be minted;
            // dev-fork.sh prefunds via impersonation instead.
            usdcMock.mint(0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, 1_000_000e18); // anvil #0
            usdcMock.mint(0x70997970C51812dc3A010C7d01b50e0d17dc79C8, 1_000_000e18); // anvil #1
            console.log("Minted USDC to Alice and Bob");
        }
    }

    /// @dev Deploy verifiers + CommitmentPool + PrivateSettlement.
    ///      Extracted into its own function to avoid "stack too deep" in run().
    function _deployZkCore(address weth)
        internal
        returns (CommitmentPool pool, PrivateSettlement privateSettlement)
    {
        address withdrawVerifier = _deployCode("WithdrawVerifier.sol:Groth16Verifier");
        address claimVerifier = _deployCode("ClaimVerifier.sol:Groth16Verifier");
        address depositVerifier = _deployCode("DepositVerifier.sol:Groth16Verifier");
        address authorizeVerifier = _deployCode("AuthorizeVerifier.sol:Groth16Verifier");
        address cancelVerifier = _deployCode("CancelVerifier.sol:Groth16Verifier");
        _authorizeVerifier = authorizeVerifier;
        console.log("WithdrawVerifier:", withdrawVerifier);
        console.log("ClaimVerifier:", claimVerifier);
        console.log("DepositVerifier:", depositVerifier);
        console.log("AuthorizeVerifier:", authorizeVerifier);
        console.log("CancelVerifier:", cancelVerifier);

        pool = new CommitmentPool(withdrawVerifier, depositVerifier, 20, 30);
        console.log("CommitmentPool:", address(pool));

        privateSettlement = new PrivateSettlement(
            address(pool), claimVerifier, weth
        );
        // settleAuth and scatterDirectAuth both require the authorize
        // verifier to be wired before they accept proofs; the constructor
        // doesn't take it (set after deploy via setAuthorizeVerifier).
        // Without this call every same-token order reverts with
        // AuthorizeVerifierNotSet (selector 0x7d234657).
        privateSettlement.setAuthorizeVerifier(authorizeVerifier);
        console.log("AuthorizeVerifier wired into PrivateSettlement");
        // cancelPrivate is gated the same way — without setCancelVerifier
        // every cancel reverts with `CancelVerifierNotSet()` (selector
        // 0xe5b08665), even though the user's wallet signed a perfectly
        // valid cancel.circom proof. Wiring it here keeps the local stack
        // self-contained for History → Pending → Cancel Order to work
        // end-to-end against a freshly-spun-up anvil.
        privateSettlement.setCancelVerifier(cancelVerifier);
        console.log("CancelVerifier wired into PrivateSettlement");
        console.log("PrivateSettlement:", address(privateSettlement));
    }
}
