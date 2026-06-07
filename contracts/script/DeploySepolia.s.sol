// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {IssuanceApprovalRegistry} from "../src/IssuanceApprovalRegistry.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {Treasury} from "../src/Treasury.sol";
import {SanctionsList} from "../src/SanctionsList.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {BatchExecutor} from "../src/BatchExecutor.sol";

/// @notice Production-shaped deploy for a PUBLIC TESTNET (Sepolia et al.).
/// @dev This is the testnet sibling of `DeployLocal.s.sol`. It deliberately
///      omits everything that is local/anvil-only in DeployLocal, because
///      those steps either revert or deploy junk on a real chain:
///
///      | DeployLocal (local)            | DeploySepolia (testnet)                |
///      |--------------------------------|----------------------------------------|
///      | MockIdentityRegistry fallback  | real IDENTITY_REGISTRY / RELAYER_…      |
///      | deploys+mints 4 mock tokens    | NO token deploy; owner whitelists later |
///      | wraps 1100 ETH to anvil testers| (removed — would revert: no funds)      |
///      | auto-registers anvil acct #1   | NO register; operator uses /register UI |
///      | reads DEPLOYER_KEY (anvil default) | no key on CLI: DEPLOYER_KEY env OR --account |
///
///      Token policy: only WETH is wired at deploy, because it is a
///      structural init param of PrivateSettlement (and FeeVault's
///      auto-unwrap). Every other token (USDC/USDT/TON/WTON/…) is added
///      AFTER deploy by the owner via `setTokenWhitelist` on both
///      CommitmentPool and PrivateSettlement — so no mock tokens are ever
///      created and you wire your existing on-chain token addresses.
///
/// Signing — pick ONE (neither puts the key on the command line / shell
/// history / process args, so nothing leaks into logs):
///   (A) Encrypted keystore (most secure — key encrypted at rest):
///       forge script script/DeploySepolia.s.sol:DeploySepolia \
///         --rpc-url "$SEPOLIA_RPC" --broadcast \
///         --account deployer-sepolia --sender 0xYourDeployer
///   (B) Env file (convenient — DEPLOYER_KEY in a gitignored contracts/.env,
///       read by the script itself so the command carries no key):
///       forge script script/DeploySepolia.s.sol:DeploySepolia \
///         --rpc-url "$SEPOLIA_RPC" --broadcast
///   DO NOT pass `--private-key 0x...` inline — that DOES leak into shell
///   history, `ps` output, and any session log.
///
/// Required env (all revert if unset/zero — no silent defaults on a real chain).
/// Network-specific addresses are SEPOLIA_-prefixed (matches SEPOLIA_RPC_URL);
/// cross-network roles stay generic.
///   SEPOLIA_IDENTITY_REGISTRY          real zk-X509 User-CA IdentityRegistry (gates deposits/claims)
///   SEPOLIA_RELAYER_IDENTITY_REGISTRY  real zk-X509 Relayer-CA IdentityRegistry (gates register())
///   SEPOLIA_WETH_ADDRESS               canonical WETH9 already deployed on the target chain
///   UPGRADE_OWNER                      ProxyAdmin owner for every proxy (multisig recommended)
///   TREASURY_ADDRESS                   Treasury owner / platform-fee recipient (multisig recommended)
/// Optional env:
///   SANCTIONS_EXTERNAL_ORACLE  external sanctions oracle, OR-combined into SanctionsList
/// Tokens (USDC/USDT/TON/…) are NOT whitelisted at deploy — owner adds them
/// on-chain post-deploy via setTokenWhitelist; the frontend reads them on-chain.
/// RPC/verify: --rpc-url sepolia (foundry.toml → SEPOLIA_RPC_URL), --verify (ETHERSCAN_API_KEY)
contract DeploySepolia is Script {
    /// @dev ProxyAdmin owner for every TransparentUpgradeableProxy below.
    ///      Resolved once from UPGRADE_OWNER; read by every `_deploy…Proxy`.
    address internal _upgradeOwner;

    /// @dev Collected for the copy-paste summary so `run()` doesn't carry a
    ///      dozen live locals (Solidity's 16-slot stack limit).
    struct Deployed {
        address identityRegistry;
        address relayerIdentityRegistry;
        address relayerRegistry;
        address issuanceApproval;
        address pool;
        address settlement;
        address gate;
        address vault;
        address treasury;
        address sanctions;
        address batchExecutor;
        address weth;
        address authVerifier16;
        address authVerifier64;
        address authVerifier128;
        // Owners / bond token + the full verifier set, for a complete ledger.
        address deployer;
        address treasuryOwner;
        address bondToken;
        address withdrawVerifier;
        address depositVerifier;
        address claimVerifier16;
        address claimVerifier64;
        address claimVerifier128;
        address cancelVerifier;
    }

    Deployed internal d;

    function run() external {
        // ── 0. Required external addresses — no mocks, no defaults ──
        address userRegistry = vm.envAddress("SEPOLIA_IDENTITY_REGISTRY");
        address relayerIdRegistry = vm.envAddress("SEPOLIA_RELAYER_IDENTITY_REGISTRY");
        address treasuryOwner = vm.envAddress("TREASURY_ADDRESS");
        address weth = vm.envAddress("SEPOLIA_WETH_ADDRESS");
        _upgradeOwner = vm.envAddress("UPGRADE_OWNER");
        require(userRegistry != address(0), "SEPOLIA_IDENTITY_REGISTRY=0");
        require(relayerIdRegistry != address(0), "SEPOLIA_RELAYER_IDENTITY_REGISTRY=0");
        require(treasuryOwner != address(0), "TREASURY_ADDRESS=0");
        require(_upgradeOwner != address(0), "UPGRADE_OWNER=0");
        require(weth != address(0), "SEPOLIA_WETH_ADDRESS=0");
        // Catch wrong-network / typo'd addresses before they silently break at
        // runtime: WETH is a structural init param of PrivateSettlement, and
        // the registries are queried (isVerified) on every deposit/register —
        // an EOA or wrong address there would deploy fine but brick the flow.
        require(weth.code.length > 0, "SEPOLIA_WETH_ADDRESS has no code on this chain");
        require(userRegistry.code.length > 0, "SEPOLIA_IDENTITY_REGISTRY has no code on this chain");
        require(relayerIdRegistry.code.length > 0, "SEPOLIA_RELAYER_IDENTITY_REGISTRY has no code on this chain");
        d.weth = weth;
        d.identityRegistry = userRegistry;
        d.relayerIdentityRegistry = relayerIdRegistry;
        d.treasuryOwner = treasuryOwner;

        // Signing: env key (B) if DEPLOYER_KEY is set, else CLI keystore (A)
        // via `--account`. No anvil-key default — a missing key on a real
        // chain must fail loudly, not silently broadcast from a known key.
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }
        // Derive the deployer deterministically: in env-key mode it's the key's
        // address (independent of any --sender / Foundry default-sender nuance);
        // in keystore mode it's msg.sender (== the required --sender). This is the
        // initial owner of the proxies, so it must match the broadcasting account.
        address deployer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;
        d.deployer = deployer;
        console.log("=== DeploySepolia (chainid", block.chainid, ") ===");
        console.log("Deployer (temp owner):", deployer);
        console.log("UPGRADE_OWNER (ProxyAdmin):", _upgradeOwner);
        console.log("IdentityRegistry (User CA):", userRegistry);
        console.log("IdentityRegistry (Relayer CA):", relayerIdRegistry);

        // ── 1. Identity gate (User CA) + relayer registry (Relayer CA) ──
        IdentityGate gate = _identityGateProxy(deployer, userRegistry);
        // Bond token = TON (ERC20 bond) via SEPOLIA_TON_ADDRESS; 0 → native-bond mode.
        // bondToken is set ONCE here (structural — no setter). minBond is NOT set
        // at deploy: the admin sets it on-chain post-deploy via the admin site
        // (setMinBond), e.g. a fixed 2000 TON. Until then minBond = 0.
        d.bondToken = vm.envOr("SEPOLIA_TON_ADDRESS", address(0));
        RelayerRegistry relayerRegistry = _relayerRegistryProxy(deployer, relayerIdRegistry, d.bondToken);
        d.gate = address(gate);
        d.relayerRegistry = address(relayerRegistry);

        // ── 2. Issuance-approval registry (admin gate for cert-issuance CTA) ──
        d.issuanceApproval = address(new IssuanceApprovalRegistry(deployer));
        console.log("IssuanceApprovalRegistry:", d.issuanceApproval);

        // ── 3. ZK core: verifiers + CommitmentPool + PrivateSettlement ──
        (CommitmentPool pool, PrivateSettlement settlement) = _deployZkCore(weth);
        d.pool = address(pool);
        d.settlement = address(settlement);

        // ── 4. Treasury + FeeVault ──
        Treasury treasury = _treasuryProxy(treasuryOwner);
        FeeVault vault = _feeVaultProxy(deployer, address(treasury));
        d.treasury = address(treasury);
        d.vault = address(vault);

        // ── 5. Wire everything together (own frame to spare run()'s stack) ──
        _wire(pool, settlement, gate, vault, relayerRegistry, weth);

        // ── 6. EIP-7702 batch executor ──
        d.batchExecutor = address(new BatchExecutor());
        console.log("BatchExecutor:", d.batchExecutor);

        vm.stopBroadcast();

        _summary();
        _writeDeployments();
    }

    // ──────────────────────────────────────────────────────────────────
    // Wiring
    // ──────────────────────────────────────────────────────────────────

    /// @dev All post-deploy wiring in one frame. Mirrors DeployLocal's
    ///      sequence, minus mock-token whitelisting — only WETH is wired
    ///      here; the owner adds the rest post-deploy.
    function _wire(
        CommitmentPool pool,
        PrivateSettlement settlement,
        IdentityGate gate,
        FeeVault vault,
        RelayerRegistry relayerRegistry,
        address weth
    ) internal {
        // 4a. Authorize settlement + whitelist WETH on both boundaries.
        pool.setAuthorizedSettlement(address(settlement));
        pool.setTokenWhitelist(weth, true);
        settlement.setTokenWhitelist(weth, true);
        console.log("WETH whitelisted on CommitmentPool + PrivateSettlement");
        // Non-WETH tokens (USDC/USDT/TON) are registered ON-CHAIN post-deploy by
        // the owner via setTokenWhitelist (admin UI / cast) on BOTH boundary
        // contracts — not from env. The frontend reads the live set on-chain via
        // getWhitelistedTokens() (#927/#928), so on-chain is the single source.

        // 4b. FeeVault: settlement may deposit fees; WETH unwraps to ETH on claim.
        vault.setAuthorizedDepositor(address(settlement), true);
        vault.setWeth(weth);

        // 4c. Wire relayer registry + fee vault into settlement.
        settlement.setRelayerRegistry(address(relayerRegistry));
        settlement.setFeeVault(address(vault));
        // Point the relayer registry at the protocol Treasury (not the deployer
        // EOA it was initialized with) so RelayerRegistry.treasury() returns the
        // real treasury for slashing/bond accounting. (review #930)
        relayerRegistry.setTreasury(vault.treasury());

        // 4d. DEX routers — whitelist only if present on this chain. On
        //     most testnets 1inch/Uniswap are absent; market orders
        //     (settleWithDex) then simply stay unavailable until a router
        //     is whitelisted post-deploy.
        _whitelistDexRouter(settlement, 0x111111125421cA6dc452d289314280a0f8842A65, "1inch Router");
        _whitelistDexRouter(settlement, 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45, "Uniswap SwapRouter02");

        // 4e. SanctionsList (empty; owner adds OFAC SDN entries post-deploy)
        //     + IdentityGate, registered on both boundary contracts.
        _deployAndWireSanctionsList(address(pool), address(settlement));
        pool.setIdentityGate(address(gate));
        settlement.setIdentityGate(address(gate));
        console.log("IdentityGate registered on CommitmentPool + PrivateSettlement");
    }

    /// @dev Whitelist a DEX router only if it exists on the target chain.
    ///      On most testnets 1inch/Uniswap are absent, so market orders
    ///      (settleWithDex) stay unavailable until a router is whitelisted.
    function _whitelistDexRouter(PrivateSettlement settlement, address router, string memory name) internal {
        if (router.code.length > 0) {
            settlement.setDexRouterWhitelist(router, true);
            console.log(string.concat(name, " whitelisted:"), router);
        } else {
            console.log(string.concat(name, " absent on this chain (skipped)"));
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Proxy deploy helpers (identical wiring to DeployLocal)
    // ──────────────────────────────────────────────────────────────────

    function _identityGateProxy(address deployer, address initialRegistry) internal returns (IdentityGate) {
        IdentityGate impl = new IdentityGate();
        bytes memory initData = abi.encodeCall(IdentityGate.initialize, (deployer, initialRegistry));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("IdentityGate impl:", address(impl));
        console.log("IdentityGate proxy:", address(proxy));
        return IdentityGate(address(proxy));
    }

    function _relayerRegistryProxy(address deployer, address relayerIdRegistry, address bondToken_)
        internal
        returns (RelayerRegistry)
    {
        if (bondToken_ != address(0)) {
            require(bondToken_.code.length > 0, "SEPOLIA_TON_ADDRESS (bondToken) has no code on this chain");
        }
        RelayerRegistry impl = new RelayerRegistry();
        // (owner, treasury, identityRegistry, bondToken). bondToken=0 → native mode;
        // non-zero → ERC20 bond. Here TON: relayers post a fixed TON bond (minBond).
        bytes memory initData =
            abi.encodeCall(RelayerRegistry.initialize, (deployer, deployer, relayerIdRegistry, bondToken_));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("RelayerRegistry impl:", address(impl));
        console.log("RelayerRegistry proxy:", address(proxy));
        return RelayerRegistry(payable(address(proxy)));
    }

    function _treasuryProxy(address treasuryOwner) internal returns (Treasury) {
        Treasury impl = new Treasury();
        bytes memory initData = abi.encodeCall(Treasury.initialize, (treasuryOwner));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("Treasury impl:", address(impl));
        console.log("Treasury proxy:", address(proxy));
        console.log("Treasury owner:", treasuryOwner);
        return Treasury(payable(address(proxy)));
    }

    function _feeVaultProxy(address deployer, address treasury_) internal returns (FeeVault) {
        FeeVault impl = new FeeVault();
        // (owner, treasury, platformFeeBps=500). owner=deployer so this script can wire it.
        bytes memory initData = abi.encodeCall(FeeVault.initialize, (deployer, treasury_, 500));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("FeeVault impl:", address(impl));
        console.log("FeeVault proxy:", address(proxy));
        return FeeVault(payable(address(proxy)));
    }

    function _commitmentPoolProxy(address withdrawVerifier, address depositVerifier) internal returns (CommitmentPool) {
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

    function _privateSettlementProxy(address pool_, address claimVerifier, address weth_)
        internal
        returns (PrivateSettlement)
    {
        address deployer = msg.sender;
        PrivateSettlement impl = new PrivateSettlement();
        bytes memory initData = abi.encodeCall(PrivateSettlement.initialize, (deployer, pool_, claimVerifier, weth_));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        console.log("PrivateSettlement impl:", address(impl));
        console.log("PrivateSettlement proxy:", address(proxy));
        return PrivateSettlement(payable(address(proxy)));
    }

    function _deployAndWireSanctionsList(address pool_, address settlement_) internal {
        SanctionsList impl = new SanctionsList();
        bytes memory initData = abi.encodeCall(SanctionsList.initialize, (msg.sender));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), _upgradeOwner, initData);
        d.sanctions = address(proxy);
        console.log("SanctionsList impl:", address(impl));
        console.log("SanctionsList proxy:", address(proxy));
        CommitmentPool(pool_).setSanctionsList(address(proxy));
        PrivateSettlement(payable(settlement_)).setSanctionsList(address(proxy));
        console.log("SanctionsList registered on CommitmentPool + PrivateSettlement");

        address externalOracle = vm.envOr("SANCTIONS_EXTERNAL_ORACLE", address(0));
        if (externalOracle != address(0)) {
            SanctionsList(address(proxy)).setExternalOracle(externalOracle);
            console.log("SanctionsList externalOracle wired:", externalOracle);
        }
    }

    /// @dev Deploy all Groth16 verifiers, CommitmentPool, PrivateSettlement,
    ///      and wire every active tier (16/64/128) + the cancel verifier.
    ///      Verifier bytecode is read from build artifacts via `vm.getCode`,
    ///      so `circuits/build` must hold the SAME artifacts that the
    ///      frontend ships (or proofs reject on-chain).
    function _deployZkCore(address weth) internal returns (CommitmentPool pool, PrivateSettlement settlement) {
        address withdrawVerifier = _deployCode("WithdrawVerifier.sol:Groth16Verifier");
        address claimVerifier = _deployCode("ClaimVerifier.sol:Groth16Verifier");
        address claimVerifier64 = _deployCode("ClaimVerifier_64.sol:Groth16Verifier");
        address claimVerifier128 = _deployCode("ClaimVerifier_128.sol:Groth16Verifier");
        address depositVerifier = _deployCode("DepositVerifier.sol:Groth16Verifier");
        address authorizeVerifier = _deployCode("AuthorizeVerifier.sol:Groth16Verifier");
        address authorizeVerifier64 = _deployCode("AuthorizeVerifier_64.sol:Groth16Verifier");
        address authorizeVerifier128 = _deployCode("AuthorizeVerifier_128.sol:Groth16Verifier");
        address cancelVerifier = _deployCode("CancelVerifier.sol:Groth16Verifier");
        d.authVerifier16 = authorizeVerifier;
        d.authVerifier64 = authorizeVerifier64;
        d.authVerifier128 = authorizeVerifier128;
        d.withdrawVerifier = withdrawVerifier;
        d.depositVerifier = depositVerifier;
        d.claimVerifier16 = claimVerifier;
        d.claimVerifier64 = claimVerifier64;
        d.claimVerifier128 = claimVerifier128;
        d.cancelVerifier = cancelVerifier;
        console.log("Verifiers deployed (withdraw/claim x3/deposit/authorize x3/cancel)");

        pool = _commitmentPoolProxy(withdrawVerifier, depositVerifier);
        settlement = _privateSettlementProxy(address(pool), claimVerifier, weth);

        // Register every live tier — constructor only seeds tier 16, so
        // 64/128 attach here or a tier-64/128 proof reverts TierNotConfigured.
        settlement.setAuthorizeVerifier(16, authorizeVerifier);
        settlement.setAuthorizeVerifier(64, authorizeVerifier64);
        settlement.setAuthorizeVerifier(128, authorizeVerifier128);
        settlement.setClaimVerifier(64, claimVerifier64);
        settlement.setClaimVerifier(128, claimVerifier128);
        settlement.setCancelVerifier(cancelVerifier);
        console.log("Authorize(16/64/128) + Claim(64/128) + Cancel verifiers wired");
    }

    function _deployCode(string memory what) internal returns (address addr) {
        bytes memory bytecode = vm.getCode(what);
        require(bytecode.length != 0, string.concat("artifact not found: ", what));
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), string.concat("deploy failed: ", what));
    }

    // ──────────────────────────────────────────────────────────────────
    // Summary
    // ──────────────────────────────────────────────────────────────────

    function _summary() internal view {
        console.log("");
        console.log("=== SEPOLIA DEPLOYMENT SUMMARY ===");
        console.log(string.concat("NEXT_PUBLIC_CHAIN_ID=", vm.toString(block.chainid)));
        console.log(string.concat("NEXT_PUBLIC_DEPLOY_BLOCK=", vm.toString(block.number)));
        console.log(string.concat("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=", vm.toString(d.relayerRegistry)));
        console.log(string.concat("NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=", vm.toString(d.pool)));
        console.log(string.concat("NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=", vm.toString(d.settlement)));
        console.log(string.concat("NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=", vm.toString(d.gate)));
        console.log(string.concat("NEXT_PUBLIC_FEE_VAULT_ADDRESS=", vm.toString(d.vault)));
        console.log(string.concat("NEXT_PUBLIC_TREASURY_ADDRESS=", vm.toString(d.treasury)));
        console.log(string.concat("NEXT_PUBLIC_SANCTIONS_LIST_ADDRESS=", vm.toString(d.sanctions)));
        console.log(string.concat("NEXT_PUBLIC_BATCH_EXECUTOR_ADDRESS=", vm.toString(d.batchExecutor)));
        console.log(string.concat("NEXT_PUBLIC_WETH_ADDRESS=", vm.toString(d.weth)));
        console.log(string.concat("IssuanceApprovalRegistry=", vm.toString(d.issuanceApproval)));
        console.log(string.concat("IdentityRegistry(User-CA)=", vm.toString(d.identityRegistry)));
        console.log(string.concat("IdentityRegistry(Relayer-CA)=", vm.toString(d.relayerIdentityRegistry)));
        console.log(string.concat("Relayer bondToken(0=native)=", vm.toString(d.bondToken)));
        console.log(string.concat("AuthorizeVerifier(16)=", vm.toString(d.authVerifier16)));
        console.log(string.concat("AuthorizeVerifier(64)=", vm.toString(d.authVerifier64)));
        console.log(string.concat("AuthorizeVerifier(128)=", vm.toString(d.authVerifier128)));
        console.log("");
        console.log("POST-DEPLOY (owner = deployer): whitelist real tokens, e.g.");
        console.log("  cast send <POOL> 'setTokenWhitelist(address,bool)' <TOKEN> true ...");
        console.log("  cast send <SETTLEMENT> 'setTokenWhitelist(address,bool)' <TOKEN> true ...");
        console.log("Relayer registration is NOT done here - use the operators /register site.");
    }

    /// @dev Write the per-network address ledger to deployments/<chainId>.json.
    ///      This is the human-readable, committable source of truth for the
    ///      team (foundry's broadcast/ is per-chain but gitignored). Token
    ///      whitelist is intentionally omitted — it is read on-chain via
    ///      getWhitelistedTokens(); only structural WETH is recorded.
    function _writeDeployments() internal {
        string memory o = "deploy";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "deployBlock", block.number);
        vm.serializeAddress(o, "commitmentPool", d.pool);
        vm.serializeAddress(o, "privateSettlement", d.settlement);
        vm.serializeAddress(o, "identityGate", d.gate);
        vm.serializeAddress(o, "relayerRegistry", d.relayerRegistry);
        vm.serializeAddress(o, "feeVault", d.vault);
        vm.serializeAddress(o, "treasury", d.treasury);
        vm.serializeAddress(o, "sanctionsList", d.sanctions);
        vm.serializeAddress(o, "batchExecutor", d.batchExecutor);
        vm.serializeAddress(o, "issuanceApprovalRegistry", d.issuanceApproval);
        vm.serializeAddress(o, "identityRegistry", d.identityRegistry);
        vm.serializeAddress(o, "relayerIdentityRegistry", d.relayerIdentityRegistry);
        vm.serializeAddress(o, "weth", d.weth);
        vm.serializeAddress(o, "authorizeVerifier16", d.authVerifier16);
        vm.serializeAddress(o, "authorizeVerifier64", d.authVerifier64);
        vm.serializeAddress(o, "authorizeVerifier128", d.authVerifier128);
        vm.serializeAddress(o, "withdrawVerifier", d.withdrawVerifier);
        vm.serializeAddress(o, "depositVerifier", d.depositVerifier);
        vm.serializeAddress(o, "claimVerifier16", d.claimVerifier16);
        vm.serializeAddress(o, "claimVerifier64", d.claimVerifier64);
        vm.serializeAddress(o, "claimVerifier128", d.claimVerifier128);
        vm.serializeAddress(o, "cancelVerifier", d.cancelVerifier);
        vm.serializeAddress(o, "bondToken", d.bondToken);
        vm.serializeAddress(o, "deployer", d.deployer);
        vm.serializeAddress(o, "treasuryOwner", d.treasuryOwner);
        string memory out = vm.serializeAddress(o, "upgradeOwner", _upgradeOwner);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("Deployments ledger written:", path);
    }
}
