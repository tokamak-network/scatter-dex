// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockSettleVerifier} from "./mocks/MockSettleVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";

contract SDToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Generic mock DEX router that simulates a swap via `swap(tokenIn, tokenOut, amountIn)`.
///      The PrivateSettlement contract calls this with arbitrary calldata — it doesn't
///      care about the DEX's specific interface, only that the buyToken balance increased.
contract MockDexRouter {
    uint256 public exchangeRate = 1e18;
    bool public shouldRevert;

    function setExchangeRate(uint256 _rate) external {
        exchangeRate = _rate;
    }

    function setShouldRevert(bool _revert) external {
        shouldRevert = _revert;
    }

    /// @dev Simple swap: pull tokenIn, push tokenOut at configured rate.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient) external returns (uint256 amountOut) {
        require(!shouldRevert, "MockDexRouter: swap reverted");
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn * exchangeRate / 1e18;
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}

/// @title SettleWithDexTest
/// @notice Tests for `PrivateSettlement.settleWithDex` — single-party DEX swap.
///         Uses a generic MockDexRouter to verify the DEX-agnostic design:
///         the contract doesn't know or care which DEX it's calling.
contract SettleWithDexTest is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    MockVerifier public withdrawVerifier;
    MockDepositVerifier public depositVerifier;
    MockSettleVerifier public settleVerifier;
    MockClaimVerifier public claimVerifier;
    MockAuthorizeVerifier public authVerifier;
    MockDexRouter public dexRouter;
    MockWETH public weth;
    SDToken public usdc;
    FeeVault public feeVault;

    address user = address(0x05E8);
    address treasury = address(0x78EA);

    // Dummy proof params (mock verifier accepts all)
    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant NULL_ESCROW    = bytes32(uint256(0xd1));
    bytes32 constant NULL_NONCE     = bytes32(uint256(0xd2));
    bytes32 constant NEW_COMMITMENT = bytes32(uint256(0xd3));
    bytes32 constant CLAIMS_ROOT    = bytes32(uint256(0xd4));
    bytes32 constant ORDER_HASH     = bytes32(uint256(0xd5));
    bytes32 constant PUB_KEY_BIND   = bytes32(uint256(0xd6));

    function setUp() public {
        withdrawVerifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        settleVerifier = new MockSettleVerifier();
        claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();
        dexRouter = new MockDexRouter();

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        weth = new MockWETH();
        settlement = new PrivateSettlement(
            address(pool),
            address(settleVerifier),
            address(claimVerifier),
            address(weth)
        );
        usdc = new SDToken("USDC", "USDC");

        // Setup FeeVault for surplus tests
        feeVault = new FeeVault(treasury, 0);
        settlement.setFeeVault(address(feeVault));
        feeVault.setAuthorizedDepositor(address(settlement), true);

        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);
        pool.setAuthorizedSettlement(address(settlement));

        settlement.setAuthorizeVerifier(address(authVerifier));
        settlement.setDexRouterWhitelist(address(dexRouter), true);

        // Fund pool with WETH (user's escrowed sell token)
        vm.deal(address(this), 1100 ether);
        weth.deposit{value: 1100 ether}();
        weth.transfer(address(pool), 1000 ether);

        // Fund DEX router with USDC (simulates DEX liquidity for WETH→USDC swaps)
        usdc.mint(address(dexRouter), 1_000_000e18);

        // Set exchange rate: 1 WETH = 2000 USDC
        dexRouter.setExchangeRate(2000e18);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _encodeDexCalldata() internal view returns (bytes memory) {
        return abi.encodeCall(
            MockDexRouter.swap,
            (address(weth), address(usdc), 10 ether, address(settlement))
        );
    }

    function _defaultDexParams() internal view returns (PrivateSettlement.SettleDexParams memory) {
        return PrivateSettlement.SettleDexParams({
            proof: PrivateSettlement.AuthorizeProof({
                proofA: proofA,
                proofB: proofB,
                proofC: proofC,
                pubKeyBind: PUB_KEY_BIND,
                commitmentRoot: pool.getLastRoot(),
                nullifier: NULL_ESCROW,
                nonceNullifier: NULL_NONCE,
                newCommitment: NEW_COMMITMENT,
                sellToken: address(weth),
                buyToken: address(usdc),
                sellAmount: 10 ether,
                buyAmount: 19_000e18,
                maxFee: 0,
                expiry: uint64(block.timestamp + 300),
                claimsRoot: CLAIMS_ROOT,
                totalLocked: 19_000e18,
                relayer: user,
                orderHash: ORDER_HASH
            }),
            dexRouter: address(dexRouter),
            dexCalldata: _encodeDexCalldata(),
            deadline: block.timestamp + 1800
        });
    }

    // ─── Happy Path ─────────────────────────────────────────────

    function test_settleWithDex_basic() public {
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        settlement.settleWithDex(p);

        // Nullifiers marked
        assertTrue(settlement.nullifiers(NULL_ESCROW));
        assertTrue(settlement.nonceNullifiers(NULL_NONCE));

        // Claims group registered
        (uint128 locked, uint128 claimed, address token) = settlement.claimsGroups(CLAIMS_ROOT);
        assertEq(token, address(usdc));
        assertEq(locked, 19_000e18);
        assertEq(claimed, 0);
    }

    function test_settleWithDex_emits_event() public {
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.expectEmit(true, true, true, true);
        emit PrivateSettlement.SettledWithDex(
            NULL_ESCROW,
            CLAIMS_ROOT,
            address(weth),
            address(usdc),
            10 ether,
            20_000e18,    // 10 WETH * 2000 rate
            19_000e18,
            user
        );

        vm.prank(user);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_surplus_to_treasury() public {
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();
        // swap gives 20_000 USDC, totalLocked = 19_000, surplus = 1_000

        vm.prank(user);
        settlement.settleWithDex(p);

        // Surplus goes directly to FeeVault's treasury address
        uint256 surplusInTreasury = usdc.balanceOf(treasury);
        assertEq(surplusInTreasury, 1_000e18);
    }

    function test_settleWithDex_multiple_dex_routers() public {
        // Deploy a second DEX router (simulates 1inch alongside Uniswap)
        MockDexRouter secondRouter = new MockDexRouter();
        usdc.mint(address(secondRouter), 1_000_000e18);
        secondRouter.setExchangeRate(2100e18); // slightly better rate
        settlement.setDexRouterWhitelist(address(secondRouter), true);

        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();
        p.dexRouter = address(secondRouter);
        p.dexCalldata = abi.encodeCall(
            MockDexRouter.swap,
            (address(weth), address(usdc), 10 ether, address(settlement))
        );

        vm.prank(user);
        settlement.settleWithDex(p);

        // Should use second router's rate: 10 * 2100 = 21_000 USDC
        // surplus = 21_000 - 19_000 = 2_000
        uint256 surplusInTreasury = usdc.balanceOf(treasury);
        assertEq(surplusInTreasury, 2_000e18);
    }

    // ─── Revert Cases ───────────────────────────────────────────

    function test_settleWithDex_slippage_reverts() public {
        // Set exchange rate low: 1 WETH = 1000 USDC (10_000 < totalLocked 19_000)
        dexRouter.setExchangeRate(1000e18);

        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PrivateSettlement.DexOutputInsufficient.selector, 10_000e18, 19_000e18));
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_dex_revert_propagates() public {
        dexRouter.setShouldRevert(true);

        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.DexCallReverted.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_double_nullifier_reverts() public {
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        settlement.settleWithDex(p);

        p.proof.claimsRoot = bytes32(uint256(0xFFFF));
        vm.prank(user);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_expired_reverts() public {
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();
        p.proof.expiry = uint64(block.timestamp - 1);

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.OrderExpired.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_wrong_relayer_reverts() public {
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        address stranger = address(0xDEAD);
        vm.prank(stranger);
        vm.expectRevert(PrivateSettlement.NotMakerOrTakerRelayer.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_deadlineExpired_reverts() public {
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();
        p.deadline = block.timestamp - 1; // already expired

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.DeadlineExpired.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_paused_reverts() public {
        settlement.setPaused(true);
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_unwhitelisted_token_reverts() public {
        SDToken badToken = new SDToken("BAD", "BAD");

        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();
        p.proof.buyToken = address(badToken);

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.TokenNotWhitelisted.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_unwhitelisted_router_reverts() public {
        MockDexRouter unknownRouter = new MockDexRouter();

        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();
        p.dexRouter = address(unknownRouter);

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.DexRouterNotWhitelisted.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_revoked_router_reverts() public {
        // Whitelist then revoke
        settlement.setDexRouterWhitelist(address(dexRouter), false);

        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.DexRouterNotWhitelisted.selector);
        settlement.settleWithDex(p);
    }

    function test_settleWithDex_invalid_proof_reverts() public {
        authVerifier.setShouldPass(false);
        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.settleWithDex(p);
    }

    // ─── Platform Fee Tests ─────────────────────────────────

    function test_settleWithDex_platformFee() public {
        // Set 1% platform fee (100 bps)
        settlement.setDexPlatformFee(100);

        // sellAmount = 10 WETH, 1% fee = 0.1 WETH → DEX gets 9.9 WETH
        // 9.9 WETH × 2000 rate = 19,800 USDC (still >= totalLocked 19,000)
        // IMPORTANT: dexCalldata must encode amountIn = 9.9 ether (post-fee)
        // because the contract only approves swapAmount to the router.
        PrivateSettlement.SettleDexParams memory p = PrivateSettlement.SettleDexParams({
            proof: PrivateSettlement.AuthorizeProof({
                proofA: proofA, proofB: proofB, proofC: proofC,
                pubKeyBind: PUB_KEY_BIND, commitmentRoot: pool.getLastRoot(),
                nullifier: NULL_ESCROW, nonceNullifier: NULL_NONCE,
                newCommitment: NEW_COMMITMENT,
                sellToken: address(weth), buyToken: address(usdc),
                sellAmount: 10 ether, buyAmount: 19_000e18, maxFee: 0,
                expiry: uint64(block.timestamp + 300),
                claimsRoot: CLAIMS_ROOT, totalLocked: 19_000e18,
                relayer: user, orderHash: ORDER_HASH
            }),
            dexRouter: address(dexRouter),
            dexCalldata: abi.encodeCall(MockDexRouter.swap, (address(weth), address(usdc), 9.9 ether, address(settlement))),
            deadline: block.timestamp + 1800
        });

        vm.prank(user);
        settlement.settleWithDex(p);

        // Platform fee (0.1 WETH) should go to treasury in sellToken (WETH)
        uint256 feeInTreasury = weth.balanceOf(treasury);
        assertEq(feeInTreasury, 0.1 ether, "Treasury should receive 1% WETH platform fee");

        // Claims group should still be registered
        (uint128 locked,, address token) = settlement.claimsGroups(CLAIMS_ROOT);
        assertEq(token, address(usdc));
        assertEq(locked, 19_000e18);
    }

    function test_settleWithDex_platformFee_tooHigh_reverts() public {
        vm.expectRevert(PrivateSettlement.DexPlatformFeeTooHigh.selector);
        settlement.setDexPlatformFee(501); // exceeds MAX_DEX_PLATFORM_FEE_BPS (500)
    }

    function test_settleWithDex_platformFee_zero_noDeduction() public {
        // Default is 0, no fee deducted
        assertEq(settlement.dexPlatformFeeBps(), 0);

        PrivateSettlement.SettleDexParams memory p = _defaultDexParams();

        vm.prank(user);
        settlement.settleWithDex(p);

        // No WETH fee to treasury
        uint256 feeInTreasury = weth.balanceOf(treasury);
        assertEq(feeInTreasury, 0);
    }
}
