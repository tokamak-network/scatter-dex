// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockSettleVerifier} from "./mocks/MockSettleVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";

/// @title SettleWithDexForkTest
/// @notice Mainnet fork tests for `settleWithDex` against real DEX routers.
///         Validates the DEX-agnostic design with two fundamentally different
///         DEX architectures:
///         1. Uniswap V3 — `exactInputSingle` on SwapRouter02
///         2. Curve — `exchange` on a StableSwap pool
///
///         Run with: forge test --match-contract SettleWithDexFork --fork-url $ETH_RPC_URL
contract SettleWithDexForkTest is Test {
    // ─── Mainnet addresses ──────────────────────────────────
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant DAI  = 0x6B175474E89094C44Da98b954EedeAC495271d0F;

    // Uniswap V3 SwapRouter02
    address constant UNISWAP_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    // Curve 3pool (DAI/USDC/USDT)
    address constant CURVE_3POOL = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;

    // ─── Contracts ──────────────────────────────────────────
    CommitmentPool pool;
    PrivateSettlement settlement;
    MockAuthorizeVerifier authVerifier;
    FeeVault feeVault;

    address user = makeAddr("user");
    address treasury = makeAddr("treasury");

    // Dummy proof params (mock verifier accepts all)
    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant PUB_KEY_BIND   = bytes32(uint256(0xf1));
    bytes32 constant ORDER_HASH     = bytes32(uint256(0xf5));

    function setUp() public {
        // Deploy mock verifiers + core contracts
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        MockSettleVerifier settleVerifier = new MockSettleVerifier();
        MockClaimVerifier claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        settlement = new PrivateSettlement(
            address(pool), address(settleVerifier), address(claimVerifier), WETH
        );

        feeVault = new FeeVault(treasury, 0);
        settlement.setFeeVault(address(feeVault));
        feeVault.setAuthorizedDepositor(address(settlement), true);

        // Token whitelists
        pool.setTokenWhitelist(WETH, true);
        pool.setTokenWhitelist(USDC, true);
        pool.setTokenWhitelist(USDT, true);
        pool.setTokenWhitelist(DAI, true);
        settlement.setTokenWhitelist(WETH, true);
        settlement.setTokenWhitelist(USDC, true);
        settlement.setTokenWhitelist(USDT, true);
        settlement.setTokenWhitelist(DAI, true);

        pool.setAuthorizedSettlement(address(settlement));
        settlement.setAuthorizeVerifier(address(authVerifier));

        // Whitelist DEX routers
        settlement.setDexRouterWhitelist(UNISWAP_ROUTER, true);
        settlement.setDexRouterWhitelist(CURVE_3POOL, true);

        // Fund pool with WETH (simulate user deposits)
        deal(WETH, address(pool), 100 ether);
        // Fund pool with USDC (for Curve test: USDC → DAI)
        deal(USDC, address(pool), 1_000_000e6);
    }

    // ─── Helpers ─────────────────────────────────────────────

    function _makeAuthProof(
        address sellToken,
        address buyToken,
        uint128 sellAmount,
        uint96 totalLocked,
        bytes32 nullifier,
        bytes32 nonceNull,
        bytes32 newCommit,
        bytes32 claimsRoot
    ) internal view returns (PrivateSettlement.AuthorizeProof memory) {
        return PrivateSettlement.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: PUB_KEY_BIND,
            commitmentRoot: pool.getLastRoot(),
            nullifier: nullifier,
            nonceNullifier: nonceNull,
            newCommitment: newCommit,
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            buyAmount: 0,  // market order: no min from circuit perspective
            maxFee: 0,
            expiry: uint64(block.timestamp + 3600),
            claimsRoot: claimsRoot,
            totalLocked: totalLocked,
            relayer: user,
            orderHash: ORDER_HASH
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 1: Uniswap V3 — WETH → USDC
    // ═══════════════════════════════════════════════════════════

    function test_fork_uniswapV3_wethToUsdc() public {
        uint128 sellAmount = 1 ether;
        // Use a low minimum so the test doesn't break when ETH price fluctuates
        uint96 totalLocked = 1e6; // 1 USDC — any valid swap will exceed this

        bytes32 nullifier = bytes32(uint256(0xe1));
        bytes32 nonceNull = bytes32(uint256(0xe2));

        // Encode Uniswap V3 SwapRouter02 exactInputSingle
        bytes memory dexCalldata = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WETH,                    // tokenIn
            USDC,                    // tokenOut
            uint24(3000),            // fee tier 0.3%
            address(settlement),     // recipient
            sellAmount,              // amountIn
            totalLocked,             // amountOutMinimum
            uint160(0)               // sqrtPriceLimitX96 (0 = no limit)
        );

        PrivateSettlement.SettleDexParams memory params = PrivateSettlement.SettleDexParams({
            proof: _makeAuthProof(WETH, USDC, sellAmount, totalLocked, nullifier, nonceNull, bytes32(uint256(0xe3)), bytes32(uint256(0xe4))),
            dexRouter: UNISWAP_ROUTER,
            dexCalldata: dexCalldata
        });

        vm.prank(user);
        settlement.settleWithDex(params);

        // Verify: nullifiers burned
        assertTrue(settlement.nullifiers(nullifier));
        assertTrue(settlement.nonceNullifiers(nonceNull));

        // Verify: claims group registered with at least totalLocked
        (address token, uint96 locked,) = settlement.claimsGroups(bytes32(uint256(0xe4)));
        assertEq(token, USDC);
        assertEq(locked, totalLocked);

        // Verify: surplus went to treasury (amountOut > totalLocked)
        uint256 treasuryBal = IERC20(USDC).balanceOf(treasury);
        assertGt(treasuryBal, 0, "Treasury should have received surplus");

        console2.log("Uniswap V3: 1 WETH -> USDC");
        console2.log("  totalLocked (claims):", totalLocked / 1e6, "USDC");
        console2.log("  surplus to treasury:", treasuryBal / 1e6, "USDC");
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 2: Curve 3pool — USDC → DAI
    // ═══════════════════════════════════════════════════════════

    function test_fork_curve3pool_usdcToDai() public {
        uint128 sellAmount = 10_000e6; // 10,000 USDC
        // Use a low minimum so the test doesn't break if the pool is imbalanced
        uint96 totalLocked = 1e18; // 1 DAI — any valid stablecoin swap will exceed this

        bytes32 nullifier = bytes32(uint256(0xc1));
        bytes32 nonceNull = bytes32(uint256(0xc2));

        // Curve 3pool indices: 0=DAI, 1=USDC, 2=USDT
        // exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)
        // USDC(1) → DAI(0)
        bytes memory dexCalldata = abi.encodeWithSignature(
            "exchange(int128,int128,uint256,uint256)",
            int128(1),          // i = USDC
            int128(0),          // j = DAI
            uint256(sellAmount),
            uint256(totalLocked) // min_dy
        );

        PrivateSettlement.SettleDexParams memory params = PrivateSettlement.SettleDexParams({
            proof: _makeAuthProof(USDC, DAI, sellAmount, totalLocked, nullifier, nonceNull, bytes32(uint256(0xc3)), bytes32(uint256(0xc4))),
            dexRouter: CURVE_3POOL,
            dexCalldata: dexCalldata
        });

        // Curve 3pool pulls tokens via transferFrom, so settlement must approve
        // The settleWithDex function handles this internally via forceApprove
        vm.prank(user);
        settlement.settleWithDex(params);

        // Verify: nullifiers burned
        assertTrue(settlement.nullifiers(nullifier));

        // Verify: claims group registered
        (address token, uint96 locked,) = settlement.claimsGroups(bytes32(uint256(0xc4)));
        assertEq(token, DAI);
        assertEq(locked, totalLocked);

        // Verify: surplus to treasury
        uint256 treasuryBal = IERC20(DAI).balanceOf(treasury);
        assertGt(treasuryBal, 0, "Treasury should have received surplus from Curve swap");

        console2.log("Curve 3pool: 10,000 USDC -> DAI");
        console2.log("  totalLocked (claims):", totalLocked / 1e18, "DAI");
        console2.log("  surplus to treasury:", treasuryBal / 1e18, "DAI");
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 3: Uniswap V3 — slippage revert (amountOut < totalLocked)
    // ═══════════════════════════════════════════════════════════

    function test_fork_uniswapV3_slippageRevert() public {
        uint128 sellAmount = 1 ether;
        // Set absurdly high totalLocked so swap output < requirement
        uint96 totalLocked = type(uint96).max; // ~79 billion USDC

        bytes memory dexCalldata = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WETH, USDC, uint24(3000), address(settlement), sellAmount, uint256(0), uint160(0)
        );

        PrivateSettlement.SettleDexParams memory params = PrivateSettlement.SettleDexParams({
            proof: _makeAuthProof(WETH, USDC, sellAmount, totalLocked, bytes32(uint256(0xf1)), bytes32(uint256(0xf2)), bytes32(uint256(0xf3)), bytes32(uint256(0xf4))),
            dexRouter: UNISWAP_ROUTER,
            dexCalldata: dexCalldata
        });

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.DexOutputInsufficient.selector);
        settlement.settleWithDex(params);
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 4: Non-whitelisted router reverts
    // ═══════════════════════════════════════════════════════════

    function test_fork_nonWhitelistedRouterReverts() public {
        address fakeRouter = makeAddr("fakeRouter");

        PrivateSettlement.SettleDexParams memory params = PrivateSettlement.SettleDexParams({
            proof: _makeAuthProof(WETH, USDC, 1 ether, 1000e6, bytes32(uint256(0xa1)), bytes32(uint256(0xa2)), bytes32(uint256(0xa3)), bytes32(uint256(0xa4))),
            dexRouter: fakeRouter,
            dexCalldata: ""
        });

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.DexRouterNotWhitelisted.selector);
        settlement.settleWithDex(params);
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 5: Platform fee — Uniswap V3 with 1% fee deduction
    // ═══════════════════════════════════════════════════════════

    function test_fork_uniswapV3_platformFee() public {
        // Set 1% platform fee
        settlement.setDexPlatformFee(100);

        uint128 sellAmount = 10 ether;
        // 1% fee = 0.1 ETH → swap 9.9 ETH, at ~$2200 → ~$21,780
        // totalLocked conservatively low
        uint96 totalLocked = 10_000e6;

        bytes32 nullifier = bytes32(uint256(0xd1));
        bytes32 nonceNull = bytes32(uint256(0xd2));

        // Compute post-fee amountIn from contract state (not hardcoded)
        uint256 feeBps = settlement.dexPlatformFeeBps();
        uint256 amountIn = uint256(sellAmount) * (10_000 - feeBps) / 10_000;

        bytes memory dexCalldata = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WETH, USDC, uint24(3000), address(settlement),
            amountIn,
            totalLocked, uint160(0)
        );

        PrivateSettlement.SettleDexParams memory params = PrivateSettlement.SettleDexParams({
            proof: _makeAuthProof(WETH, USDC, sellAmount, totalLocked, nullifier, nonceNull, bytes32(uint256(0xd3)), bytes32(uint256(0xd4))),
            dexRouter: UNISWAP_ROUTER,
            dexCalldata: dexCalldata
        });

        vm.prank(user);
        settlement.settleWithDex(params);

        // Platform fee (1% of 10 ETH = 0.1 ETH) sent to treasury in WETH
        uint256 wethFee = IERC20(WETH).balanceOf(treasury);
        assertEq(wethFee, 0.1 ether, "Treasury should receive 1% WETH platform fee");

        // Claims group registered
        (address token, uint96 locked,) = settlement.claimsGroups(bytes32(uint256(0xd4)));
        assertEq(token, USDC);
        assertEq(locked, totalLocked);

        console2.log("Uniswap V3 + 1% platform fee: 10 WETH");
        console2.log("  platform fee:", wethFee / 1e18, "WETH");
        console2.log("  claims:", totalLocked / 1e6, "USDC");
    }
}
