// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {SanctionsList} from "../src/SanctionsList.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
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
    // The summary surfaces all three live tiers so a dev sanity-checking
    // the deploy can spot a missing tier registration.
    address internal _authorizeVerifier;
    address internal _authorizeVerifier64;
    address internal _authorizeVerifier128;
    /// @dev Resolved once per `run()` (in `_resolveUpgradeOwner`) and used by
    ///      every `_deployXProxy` helper. `address(0)` is treated as "not
    ///      resolved yet" — the helpers read this directly instead of calling
    ///      `vm.envOr` themselves, so we don't re-print the default warning
    ///      five times per deploy.
    address internal _upgradeOwner;

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
        // OFAC SDN-style address blocklist behind TransparentUpgradeableProxy.
        // Empty by default in local deploys; owner can `addSanction(addr)` or
        // `addSanctionsBatch(addrs)` post-deploy. Production deploys may
        // swap the implementation via the proxy admin for any other
        // contract that satisfies `ISanctionsList` — e.g. an adapter
        // around the Chainalysis SDN Oracle (mainnet `0x40C57923...`),
        // a merged-source bespoke list, or a stricter regional variant.
        address sanctionsList;
    }

    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        vm.startBroadcast(deployerKey);
        address deployer = msg.sender;
        _resolveUpgradeOwner(deployer);

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

        // 2. Identity gate (User CA) — behind TransparentUpgradeableProxy.
        IdentityGate gate = _deployIdentityGateProxy(deployer, userRegistry);

        // 3. Relayer registry (Relayer CA) — behind TransparentUpgradeableProxy.
        RelayerRegistry relayerRegistry = _deployRelayerRegistryProxy(deployer, relayerRegistry_);

        // 4. Tokens — mock by default, or real mainnet addresses when
        //    USE_REAL_TOKENS is set (fork mode). Real tokens are required
        //    for `settleWithDex` to route through actual 1inch / Uniswap
        //    liquidity; mock tokens have no on-chain DEX pools. Extracted
        //    into a helper to keep run()'s stack-depth below the limit.
        bool useRealTokens = vm.envOr("USE_REAL_TOKENS", false);
        (address wethAddr, address usdcAddr, address usdtAddr, address wtonAddr) = _deployOrPickTokens(useRealTokens);

        // 6. Register zk-relayer (anvil Account #1)
        // WARNING: Anvil default key — NEVER use in production
        // SKIP_RELAYER_REGISTER=1 bypasses this — useful in
        // integration mode where Account #1 isn't yet identity-
        // verified in zk-X509's IdentityRegistry. After the deployer
        // seeds proofs for the anvil testers via zk-X509's evm CLI,
        // re-run register manually with the same arguments.
        bool skipRelayerRegister = vm.envOr("SKIP_RELAYER_REGISTER", false);
        if (!skipRelayerRegister) {
            uint256 zkRelayerKey = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
            vm.stopBroadcast();
            vm.startBroadcast(zkRelayerKey);
            relayerRegistry.register("http://localhost:3002", "Relayer-A", 30, 0);
            console.log("Account #1 registered as zk-relayer");
            vm.stopBroadcast();
            vm.startBroadcast(deployerKey);
        } else {
            console.log("SKIP_RELAYER_REGISTER=1: relayer registration skipped");
        }

        // ── ZK Private Settlement ────────────────────────────────

        // 7-9. Deploy verifiers, CommitmentPool, and PrivateSettlement.
        //      Extracted into a helper to avoid "stack too deep".
        (CommitmentPool pool, PrivateSettlement privateSettlement) = _deployZkCore(wethAddr);

        // 10. Authorize + whitelist — every token from
        // `_deployOrPickTokens` (real-fork or mock) is whitelisted so
        // the LAUNCH_TOKENS lineup (ETH/USDC/USDT/TON) is fully
        // exercisable end-to-end on a fresh local stack.
        pool.setAuthorizedSettlement(address(privateSettlement));
        pool.setTokenWhitelist(wethAddr, true);
        pool.setTokenWhitelist(usdcAddr, true);
        privateSettlement.setTokenWhitelist(wethAddr, true);
        privateSettlement.setTokenWhitelist(usdcAddr, true);
        if (usdtAddr != address(0)) {
            pool.setTokenWhitelist(usdtAddr, true);
            privateSettlement.setTokenWhitelist(usdtAddr, true);
        }
        if (wtonAddr != address(0)) {
            pool.setTokenWhitelist(wtonAddr, true);
            privateSettlement.setTokenWhitelist(wtonAddr, true);
        }

        // 11. Deploy FeeVault behind TransparentUpgradeableProxy (5% platform fee, treasury = deployer).
        //     Vault owner = deployer so this script can wire setAuthorizedDepositor below.
        //     ProxyAdmin owner = UPGRADE_OWNER env (multisig on mainnet); falls back to deployer.
        FeeVault vault = _deployFeeVaultProxy(deployer);
        vault.setAuthorizedDepositor(address(privateSettlement), true);

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

        // 14. Deploy SanctionsList behind TransparentUpgradeableProxy
        //     and register it on both boundary contracts. The helper
        //     does the proxy deploy AND both `setSanctionsList` calls
        //     in one frame — `run()` never sees the proxy as a local,
        //     and the summary path below reads it back from
        //     `pool.sanctionsList()`. Both choices avoid Solidity's
        //     16-slot stack limit in `run()`.
        //
        //     Local deploys start with an empty list — owner adds OFAC
        //     SDN entries post-deploy via `addSanction(addr)` or
        //     `addSanctionsBatch(addrs)`. Production deploys can swap
        //     the implementation via the proxy admin for any other
        //     contract that satisfies `ISanctionsList` — e.g. an
        //     adapter around the Chainalysis SDN Oracle.
        _deployAndWireSanctionsList(address(pool), address(privateSettlement));

        // 15. Point both boundary contracts at the User-CA IdentityGate so
        //     deposits (depositor) and claims/withdraws (recipient) are
        //     gated on a current zk-X509 attestation on-chain — not just in
        //     the frontend. Wired in a helper for the same stack-limit
        //     reason as `_deployAndWireSanctionsList`.
        _wireIdentityGate(address(pool), address(privateSettlement), address(gate));

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
        d.usdcDecimals = uint8(6);
        // Mock mode now also deploys USDT + TON (see _deployOrPickTokens),
        // so propagate those addresses into the summary regardless of
        // real-vs-mock — the summary line is what apps consume to wire
        // up `NEXT_PUBLIC_TOKENS`.
        d.usdt = usdtAddr;
        d.wton = wtonAddr;
        d.pool = address(pool);
        d.privateSettlement = address(privateSettlement);
        d.gate = address(gate);
        d.vault = address(vault);
        d.batchExecutor = address(batchExecutor);
        // Read the sanctions proxy address back from the contract that
        // was wired with it — no `run()`-local needed.
        d.sanctionsList = address(pool.sanctionsList());
        _printSummary(d);
    }

    function _printSummary(Deployed memory d) internal {
        address relayerRegistry = d.relayerRegistry;
        address weth = d.weth;
        address usdc = d.usdc;
        address pool = d.pool;
        address privateSettlement = d.privateSettlement;
        address gate = d.gate;
        address vault = d.vault;
        address batchExecutor = d.batchExecutor;
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
            // In real-fork mode this is the on-chain WTON (27 dec); in
            // mock mode the slot holds a TON mock (18 dec) sized to
            // match `LAUNCH_TOKENS["TON"]` so wizard `parseUnits`
            // matches the contract's decimals.
            tokens = string.concat(tokens, ",", _tonEntry(d.wton));
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
        _printSanctionsAndVerifiers(d);
    }

    /// @dev Lifted out to keep `_printSummary`'s stack within the
    ///      16-slot limit. Surfaces the SanctionsList proxy and every
    ///      live authorize-verifier tier so an operator running
    ///      `dev.sh` can spot a missing tier registration.
    function _printSanctionsAndVerifiers(Deployed memory d) internal view {
        // SanctionsList proxy — informational; the boundary contracts
        // read the address from their own storage (set at deploy time
        // via setSanctionsList). Surfaced so an operator can copy it
        // for OFAC SDN updates (`addSanction[Batch]`).
        console.log(string.concat("NEXT_PUBLIC_SANCTIONS_LIST_ADDRESS=", vm.toString(d.sanctionsList)));
        // Surface every active tier's authorize verifier so a dev
        // running `dev.sh` can spot a missing tier registration in the
        // summary; the SDK reads addresses from the on-chain registry,
        // so these env vars are informational rather than required.
        console.log(string.concat("NEXT_PUBLIC_AUTHORIZE_VERIFIER_ADDRESS=", vm.toString(_authorizeVerifier)));
        console.log(string.concat("NEXT_PUBLIC_AUTHORIZE_VERIFIER_64_ADDRESS=", vm.toString(_authorizeVerifier64)));
        console.log(string.concat("NEXT_PUBLIC_AUTHORIZE_VERIFIER_128_ADDRESS=", vm.toString(_authorizeVerifier128)));
    }

    /// @dev Lifted out to keep `_printSummary`'s stack within the
    ///      EVM's 16-slot limit. Returns `<addr>:<symbol>:<decimals>`.
    function _tonEntry(address tonAddr) internal returns (string memory) {
        bool useRealTokens = vm.envOr("USE_REAL_TOKENS", false);
        return string.concat(
            vm.toString(tonAddr), ":",
            useRealTokens ? "WTON:27" : "TON:18"
        );
    }

    /// @dev Resolve `UPGRADE_OWNER` once per deploy. On local dev chains
    ///      (anvil 31337 / hardhat 1337 / `dev-fork.sh` mainnet fork 31338)
    ///      we fall back to the deployer for convenience and warn. On any
    ///      other chain id (i.e. a real network) we hard-revert — missing
    ///      the env var on mainnet would otherwise hand single-EOA admin
    ///      authority over all six proxies to the deployer hot key. See
    ///      PR 8 mainnet-readiness audit (L-1).
    function _resolveUpgradeOwner(address deployer) internal {
        address envOwner = vm.envOr("UPGRADE_OWNER", address(0));
        if (envOwner == address(0)) {
            uint256 cid = block.chainid;
            // 31337: anvil default. 1337: hardhat default.
            // 31338: `scripts/dev-fork.sh` mainnet-fork env (distinguished
            //        from plain anvil so apps can tell forked from clean).
            bool isLocalDevChain = cid == 31337 || cid == 1337 || cid == 31338;
            require(
                isLocalDevChain,
                string.concat(
                    "UPGRADE_OWNER unset on non-local chain (chainid=",
                    vm.toString(cid),
                    "). Set UPGRADE_OWNER to a multisig before deploy."
                )
            );
            console.log("");
            console.log("[WARN] UPGRADE_OWNER unset - defaulting ProxyAdmin owner to deployer");
            console.log("       OK for local anvil/hardhat only; ANY non-local chain hard-reverts here.");
            console.log("");
            _upgradeOwner = deployer;
        } else {
            _upgradeOwner = envOwner;
        }
        console.log("UPGRADE_OWNER (ProxyAdmin):", _upgradeOwner);
    }

    /// @dev Deploy SanctionsList behind a TransparentUpgradeableProxy
    ///      and register it on both boundary contracts. Does not
    ///      return the proxy address — the caller (and the summary
    ///      path) read it back from `pool.sanctionsList()` to keep
    ///      `run()`'s stack under Solidity's 16-slot limit. Bundled
    ///      into one helper for the same reason: a fresh local for
    ///      the proxy plus separate `setSanctionsList` calls in the
    ///      caller would each push the limit.
    ///
    ///      Owner = deployer (so the script can wire the boundary
    ///      contracts via setSanctionsList). ProxyAdmin owner =
    ///      `_upgradeOwner` resolved in `_resolveUpgradeOwner`.
    ///      Local deploys start with an empty list; the operations
    ///      multisig populates it post-deploy via `addSanction(addr)`
    ///      or `addSanctionsBatch(addrs)`. Production deploys can swap
    ///      the implementation via the proxy admin for any other
    ///      contract that satisfies `ISanctionsList` — e.g. an adapter
    ///      around the Chainalysis SDN Oracle.
    function _deployAndWireSanctionsList(address pool_, address settlement_) internal {
        SanctionsList impl = new SanctionsList();
        bytes memory initData = abi.encodeCall(SanctionsList.initialize, (msg.sender));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("SanctionsList impl:", address(impl));
        console.log("SanctionsList proxy:", address(proxy));
        CommitmentPool(pool_).setSanctionsList(address(proxy));
        PrivateSettlement(payable(settlement_)).setSanctionsList(address(proxy));
        console.log("SanctionsList registered on CommitmentPool + PrivateSettlement");

        // Optional: chain the self-managed list with an external oracle (e.g.
        // Chainalysis SDN Oracle at 0x40C57923... on mainnet). Set via
        // env var SANCTIONS_EXTERNAL_ORACLE — addresses are OR-combined inside
        // SanctionsList.isSanctioned. Local anvil leaves this unset.
        address externalOracle = vm.envOr("SANCTIONS_EXTERNAL_ORACLE", address(0));
        if (externalOracle != address(0)) {
            SanctionsList(address(proxy)).setExternalOracle(externalOracle);
            console.log("SanctionsList externalOracle wired:", externalOracle);
        }
    }

    /// @dev Register the IdentityGate on both boundary contracts. Kept in its
    ///      own frame so `run()` doesn't spend stack slots on the calls — same
    ///      rationale as `_deployAndWireSanctionsList`.
    function _wireIdentityGate(address pool_, address settlement_, address gate_) internal {
        CommitmentPool(pool_).setIdentityGate(gate_);
        PrivateSettlement(payable(settlement_)).setIdentityGate(gate_);
        console.log("IdentityGate registered on CommitmentPool + PrivateSettlement");
    }

    /// @dev Deploy FeeVault behind a TransparentUpgradeableProxy.
    ///      Vault owner = deployer (so the script can finish wiring).
    ///      ProxyAdmin owner = `_upgradeOwner` resolved in `_resolveUpgradeOwner`.
    function _deployFeeVaultProxy(address deployer) internal returns (FeeVault) {
        FeeVault impl = new FeeVault();
        bytes memory initData = abi.encodeCall(FeeVault.initialize, (deployer, deployer, 500));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("FeeVault impl:", address(impl));
        console.log("FeeVault proxy:", address(proxy));
        return FeeVault(address(proxy));
    }

    function _deployIdentityGateProxy(address deployer, address initialRegistry) internal returns (IdentityGate) {
        IdentityGate impl = new IdentityGate();
        bytes memory initData = abi.encodeCall(IdentityGate.initialize, (deployer, initialRegistry));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("IdentityGate impl:", address(impl));
        console.log("IdentityGate proxy:", address(proxy));
        return IdentityGate(address(proxy));
    }

    function _deployPrivateSettlementProxy(address pool_, address claimVerifier, address weth_)
        internal
        returns (PrivateSettlement)
    {
        address deployer = msg.sender;
        PrivateSettlement impl = new PrivateSettlement();
        bytes memory initData =
            abi.encodeCall(PrivateSettlement.initialize, (deployer, pool_, claimVerifier, weth_));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("PrivateSettlement impl:", address(impl));
        console.log("PrivateSettlement proxy:", address(proxy));
        return PrivateSettlement(payable(address(proxy)));
    }

    function _deployCommitmentPoolProxy(address withdrawVerifier, address depositVerifier)
        internal
        returns (CommitmentPool)
    {
        address deployer = msg.sender;
        CommitmentPool impl = new CommitmentPool();
        bytes memory initData = abi.encodeCall(
            CommitmentPool.initialize, (deployer, withdrawVerifier, depositVerifier, uint32(20), uint32(30))
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("CommitmentPool impl:", address(impl));
        console.log("CommitmentPool proxy:", address(proxy));
        return CommitmentPool(address(proxy));
    }

    function _deployRelayerRegistryProxy(address deployer, address relayerIdRegistry)
        internal
        returns (RelayerRegistry)
    {
        RelayerRegistry impl = new RelayerRegistry();
        bytes memory initData =
            abi.encodeCall(RelayerRegistry.initialize, (deployer, deployer, relayerIdRegistry, address(0)));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("RelayerRegistry impl:", address(impl));
        console.log("RelayerRegistry proxy:", address(proxy));
        return RelayerRegistry(payable(address(proxy)));
    }

    function _deployCode(string memory what) internal returns (address addr) {
        bytes memory bytecode = vm.getCode(what);
        // Surface the artifact name in both diagnostics. `getCode`
        // returns empty bytes when the artifact is missing or
        // misspelled (the `path:contract` format is exact-match);
        // catching that early gives a clear "X.sol not found" error
        // instead of the opaque `create` failure that follows.
        require(bytecode.length != 0, string.concat("artifact not found: ", what));
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), string.concat("deploy failed: ", what));
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
            // Mock branch — deploy a mock for every entry in
            // `LAUNCH_TOKENS` so the apps don't need separate per-token
            // env wiring and the deposit wizard's USDC/USDT/TON paths
            // are exercisable end-to-end against anvil.
            MockWETH wethMock = new MockWETH();
            MockToken usdcMock = new MockToken("USD Coin", "USDC", 6);
            MockToken usdtMock = new MockToken("Tether USD", "USDT", 6);
            MockToken tonMock = new MockToken("Tokamak Network", "TON", 18);
            weth = address(wethMock);
            usdc = address(usdcMock);
            usdt = address(usdtMock);
            wton = address(tonMock);
            console.log("WETH:", weth);
            console.log("USDC:", usdc);
            console.log("USDT:", usdt);
            console.log("TON:", wton);

            // Pre-fund anvil accounts #0–#10 so deposit / settle / claim
            // demos work for any tester without hand-minting. WETH has no
            // mint() (it's a real WETH9 mock), so the deployer wraps ETH
            // once and transfers — uses ~1100 ETH from anvil's deployer
            // prefund, which is fine. Real USDC can't be minted;
            // dev-fork.sh prefunds via impersonation in fork mode.
            address[11] memory testers = [
                0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, // anvil #0
                0x70997970C51812dc3A010C7d01b50e0d17dc79C8, // anvil #1
                0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC, // anvil #2
                0x90F79bf6EB2c4f870365E785982E1f101E93b906, // anvil #3
                0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65, // anvil #4
                0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc, // anvil #5
                0x976EA74026E726554dB657fA54763abd0C3a0aa9, // anvil #6
                0x14dC79964da2C08b23698B3D3cc7Ca32193d9955, // anvil #7
                0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f, // anvil #8
                0xa0Ee7A142d267C1f36714E4a8F75612F20a79720, // anvil #9
                0xBcd4042DE499D14e55001CcbB24a551F3b954096  // anvil #10
            ];
            wethMock.deposit{value: uint256(testers.length) * 100 ether}();
            for (uint256 i = 0; i < testers.length; i++) {
                wethMock.transfer(testers[i], 100 ether);  // 100 WETH (18 dec)
                usdcMock.mint(testers[i], 1_000_000e6);    // 1M USDC (6 dec)
                usdtMock.mint(testers[i], 1_000_000e6);    // 1M USDT (6 dec)
                tonMock.mint(testers[i], 100_000e18);      // 100k TON (18 dec)
            }
            console.log("Minted WETH/USDC/USDT/TON to anvil testers (11 accounts: #0-#10)");
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
        address claimVerifier64 = _deployCode("ClaimVerifier_64.sol:Groth16Verifier");
        address claimVerifier128 = _deployCode("ClaimVerifier_128.sol:Groth16Verifier");
        address depositVerifier = _deployCode("DepositVerifier.sol:Groth16Verifier");
        address authorizeVerifier = _deployCode("AuthorizeVerifier.sol:Groth16Verifier");
        address authorizeVerifier64 = _deployCode("AuthorizeVerifier_64.sol:Groth16Verifier");
        address authorizeVerifier128 = _deployCode("AuthorizeVerifier_128.sol:Groth16Verifier");
        address cancelVerifier = _deployCode("CancelVerifier.sol:Groth16Verifier");
        _authorizeVerifier = authorizeVerifier;
        _authorizeVerifier64 = authorizeVerifier64;
        _authorizeVerifier128 = authorizeVerifier128;
        console.log("WithdrawVerifier:", withdrawVerifier);
        console.log("ClaimVerifier (tier 16):", claimVerifier);
        console.log("ClaimVerifier (tier 64):", claimVerifier64);
        console.log("ClaimVerifier (tier 128):", claimVerifier128);
        console.log("DepositVerifier:", depositVerifier);
        console.log("AuthorizeVerifier (tier 16):", authorizeVerifier);
        console.log("AuthorizeVerifier (tier 64):", authorizeVerifier64);
        console.log("AuthorizeVerifier (tier 128):", authorizeVerifier128);
        console.log("CancelVerifier:", cancelVerifier);

        pool = _deployCommitmentPoolProxy(withdrawVerifier, depositVerifier);

        privateSettlement = _deployPrivateSettlementProxy(address(pool), claimVerifier, weth);
        // settleAuth and scatterDirectAuth both require an authorize
        // verifier to be wired for the proof's tier before they accept
        // proofs; the constructor doesn't take it (set after deploy via
        // setAuthorizeVerifier). All three live tiers (16 / 64 / 128)
        // ship from the multi-tier ceremony — register each so a
        // wizard run that picks tier-64 / tier-128 doesn't revert with
        // TierNotConfigured. Same pattern for the matching claim
        // verifiers; the constructor only seeds tier 16, so 64 / 128
        // attach via setClaimVerifier(tier, …).
        privateSettlement.setAuthorizeVerifier(16, authorizeVerifier);
        privateSettlement.setAuthorizeVerifier(64, authorizeVerifier64);
        privateSettlement.setAuthorizeVerifier(128, authorizeVerifier128);
        privateSettlement.setClaimVerifier(64, claimVerifier64);
        privateSettlement.setClaimVerifier(128, claimVerifier128);
        console.log("AuthorizeVerifier (16/64/128) wired into PrivateSettlement");
        console.log("ClaimVerifier (64/128) wired into PrivateSettlement");
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
