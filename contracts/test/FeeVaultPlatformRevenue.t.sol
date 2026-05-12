// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MCK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Hooks `transfer` to re-enter FeeVault, used to prove the
///      ReentrancyGuard on platformRevenue paths actually fires.
contract ReentrantToken is ERC20 {
    FeeVault public vault;
    address public attacker;
    bool public attacking;

    constructor() ERC20("Reenter", "REE") {}
    function setup(FeeVault _v, address _a) external { vault = _v; attacker = _a; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function arm() external { attacking = true; }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attacking && msg.sender == address(vault)) {
            attacking = false; // one-shot
            vault.withdrawPlatformRevenue(address(this));
        }
        return super.transfer(to, amount);
    }
}

/// @notice Exercises FeeVault.platformRevenue accounting introduced for
///         market-order platform fees and positive-slippage surplus in
///         PrivateSettlement.settleWithDex.
contract FeeVaultPlatformRevenueTest is Test {
    FeeVault public vault;
    MockERC20 public token;

    address treasury = address(0xCAFE);
    address relayer = address(0xBEEF);
    address depositor = address(0xDEAD);
    address outsider = address(0xFACE);

    function setUp() public {
        vault = ProxyDeployer.deployFeeVault(address(this), address(this), treasury, 500); // 5% relayer-claim platform fee (separate bucket)
        token = new MockERC20();
        vault.setAuthorizedDepositor(depositor, true);
    }

    // ─── accrueDexSurplus / accrueDexFee: happy path ────────────

    function test_accrueDexSurplus_credits_bucket_and_emits() public {
        token.mint(address(vault), 100 ether);

        // PlatformSurplusFromDex indexes `token` (topic1); `amount` is data.
        vm.expectEmit(true, false, false, true);
        emit FeeVault.PlatformSurplusFromDex(address(token), 100 ether);

        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 100 ether);

        assertEq(vault.platformRevenue(address(token)), 100 ether);
        // Relayer balances are unaffected — platformRevenue is a separate ledger.
        assertEq(vault.balances(relayer, address(token)), 0);
        assertEq(vault.totalTracked(address(token)), 0);
    }

    function test_accrueDexFee_credits_bucket_and_emits() public {
        token.mint(address(vault), 25 ether);

        vm.expectEmit(true, false, false, true);
        emit FeeVault.PlatformFeeFromDex(address(token), 25 ether);

        vm.prank(depositor);
        vault.accrueDexFee(address(token), 25 ether);

        assertEq(vault.platformRevenue(address(token)), 25 ether);
    }

    function test_platformRevenue_accumulates_across_sources() public {
        token.mint(address(vault), 30 ether);

        vm.startPrank(depositor);
        vault.accrueDexFee(address(token), 10 ether);
        vault.accrueDexSurplus(address(token), 20 ether);
        vm.stopPrank();

        assertEq(vault.platformRevenue(address(token)), 30 ether);
    }

    function test_accrueDexSurplus_zero_amount_is_noop() public {
        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 0);
        assertEq(vault.platformRevenue(address(token)), 0);
    }

    function test_accrueDexFee_zero_amount_is_noop() public {
        vm.prank(depositor);
        vault.accrueDexFee(address(token), 0);
        assertEq(vault.platformRevenue(address(token)), 0);
    }

    // ─── authorization ──────────────────────────────────────────

    function test_accrueDexSurplus_reverts_if_unauthorized() public {
        token.mint(address(vault), 1 ether);
        vm.prank(outsider);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.accrueDexSurplus(address(token), 1 ether);
    }

    function test_accrueDexFee_reverts_if_unauthorized() public {
        token.mint(address(vault), 1 ether);
        vm.prank(outsider);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.accrueDexFee(address(token), 1 ether);
    }

    function test_accrueDexSurplus_reverts_if_deauthorized() public {
        vault.setAuthorizedDepositor(depositor, false);
        token.mint(address(vault), 1 ether);
        vm.prank(depositor);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.accrueDexSurplus(address(token), 1 ether);
    }

    function test_accrueDexFee_reverts_if_deauthorized() public {
        vault.setAuthorizedDepositor(depositor, false);
        token.mint(address(vault), 1 ether);
        vm.prank(depositor);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.accrueDexFee(address(token), 1 ether);
    }

    function test_accrueDexSurplus_reverts_if_zero_token() public {
        vm.prank(depositor);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.accrueDexSurplus(address(0), 1 ether);
    }

    function test_accrueDexFee_reverts_if_zero_token() public {
        vm.prank(depositor);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.accrueDexFee(address(0), 1 ether);
    }

    // ─── balance invariant ──────────────────────────────────────

    function test_accrueDexSurplus_reverts_when_vault_underfunded() public {
        // No mint — vault holds 0 tokens. Crediting 1 ether should revert.
        vm.prank(depositor);
        vm.expectRevert(FeeVault.InsufficientTokenBalance.selector);
        vault.accrueDexSurplus(address(token), 1 ether);
    }

    function test_platformRevenue_invariant_couples_with_relayer_balances() public {
        // Vault holds 100. 60 credited to relayer first; remaining 40 covers
        // up to 40 platform revenue. Going over MUST revert.
        token.mint(address(vault), 100 ether);
        vm.prank(depositor);
        vault.deposit(relayer, address(token), 60 ether);

        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 40 ether);
        assertEq(vault.platformRevenue(address(token)), 40 ether);

        vm.prank(depositor);
        vm.expectRevert(FeeVault.InsufficientTokenBalance.selector);
        vault.accrueDexSurplus(address(token), 1);
    }

    function test_deposit_relayer_invariant_couples_with_platform_revenue() public {
        // Inverse: platform revenue must not let the relayer-deposit path
        // over-commit the same underlying balance.
        token.mint(address(vault), 100 ether);

        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 40 ether);

        vm.prank(depositor);
        vault.deposit(relayer, address(token), 60 ether);

        // Vault balance fully spoken for — any further credit must revert.
        vm.prank(depositor);
        vm.expectRevert(FeeVault.InsufficientTokenBalance.selector);
        vault.deposit(relayer, address(token), 1);
    }

    // ─── withdrawPlatformRevenue: happy path ────────────────────

    function test_withdrawPlatformRevenue_moves_tokens_to_treasury() public {
        token.mint(address(vault), 100 ether);
        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 100 ether);

        vm.expectEmit(true, true, false, true);
        emit FeeVault.PlatformRevenueWithdrawn(address(token), 100 ether, treasury);

        vm.prank(treasury);
        vault.withdrawPlatformRevenue(address(token));

        assertEq(token.balanceOf(treasury), 100 ether);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.platformRevenue(address(token)), 0);
    }

    function test_withdrawPlatformRevenue_owner_can_also_pull() public {
        // Owner acts as operational fallback in case treasury key is unavailable.
        token.mint(address(vault), 50 ether);
        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 50 ether);

        // Owner is the deployer (this contract); it still sends to treasury,
        // never to msg.sender.
        vault.withdrawPlatformRevenue(address(token));
        assertEq(token.balanceOf(treasury), 50 ether);
        assertEq(vault.platformRevenue(address(token)), 0);
    }

    function test_withdrawPlatformRevenue_reverts_if_unauthorized() public {
        token.mint(address(vault), 10 ether);
        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 10 ether);

        vm.prank(outsider);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.withdrawPlatformRevenue(address(token));
    }

    function test_withdrawPlatformRevenue_reverts_when_empty() public {
        vm.prank(treasury);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.withdrawPlatformRevenue(address(token));
    }

    function test_withdrawPlatformRevenue_reverts_on_zero_token() public {
        vm.prank(treasury);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.withdrawPlatformRevenue(address(0));
    }

    // ─── interaction with setTreasury ───────────────────────────

    function test_withdrawPlatformRevenue_follows_treasury_rotation() public {
        token.mint(address(vault), 10 ether);
        vm.prank(depositor);
        vault.accrueDexSurplus(address(token), 10 ether);

        address newTreasury = address(0xBABE);
        vault.setTreasury(newTreasury);

        // Old treasury loses withdraw privilege.
        vm.prank(treasury);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.withdrawPlatformRevenue(address(token));

        // New treasury can pull, and the tokens land in the new address.
        vm.prank(newTreasury);
        vault.withdrawPlatformRevenue(address(token));
        assertEq(token.balanceOf(newTreasury), 10 ether);
        assertEq(token.balanceOf(treasury), 0);
    }

    // ─── multi-token isolation ──────────────────────────────────

    function test_platformRevenue_buckets_are_token_scoped() public {
        MockERC20 tokenB = new MockERC20();
        token.mint(address(vault), 10 ether);
        tokenB.mint(address(vault), 7 ether);

        vm.startPrank(depositor);
        vault.accrueDexSurplus(address(token), 10 ether);
        vault.accrueDexFee(address(tokenB), 7 ether);
        vm.stopPrank();

        assertEq(vault.platformRevenue(address(token)), 10 ether);
        assertEq(vault.platformRevenue(address(tokenB)), 7 ether);

        // Withdrawing token A leaves token B untouched.
        vm.prank(treasury);
        vault.withdrawPlatformRevenue(address(token));
        assertEq(vault.platformRevenue(address(token)), 0);
        assertEq(vault.platformRevenue(address(tokenB)), 7 ether);
        assertEq(token.balanceOf(treasury), 10 ether);
        assertEq(tokenB.balanceOf(treasury), 0);
    }

    // ─── reentrancy ─────────────────────────────────────────────

    function test_withdrawPlatformRevenue_rejects_reentry() public {
        ReentrantToken rt = new ReentrantToken();
        rt.setup(vault, address(this));
        rt.mint(address(vault), 5 ether);

        vm.prank(depositor);
        vault.accrueDexSurplus(address(rt), 5 ether);

        // Hook re-enters `withdrawPlatformRevenue` mid-transfer; the outer
        // call reverts because OZ ReentrancyGuard flags the nested entry.
        rt.arm();
        vm.prank(treasury);
        vm.expectRevert();
        vault.withdrawPlatformRevenue(address(rt));
    }

    // ─── relayer claim path ─────────────────────────────────────

    function test_relayer_claim_emits_PlatformFeeFromRelayerClaim() public {
        // Setup: 100 backing balance. Credit 40 to relayer + 60 to platform.
        token.mint(address(vault), 100 ether);
        vm.startPrank(depositor);
        vault.deposit(relayer, address(token), 40 ether);
        vault.accrueDexSurplus(address(token), 60 ether);
        vm.stopPrank();

        // Relayer claims 40 — 5% platform fee = 2 ether to treasury,
        // and the new event labels that direct-skim flow.
        vm.expectEmit(true, true, false, true);
        emit FeeVault.PlatformFeeFromRelayerClaim(address(token), 2 ether, relayer);

        vm.prank(relayer);
        vault.claim(address(token));

        assertEq(vault.balances(relayer, address(token)), 0);
        assertEq(token.balanceOf(relayer), 38 ether);
        assertEq(token.balanceOf(treasury), 2 ether); // 5% of 40

        // platformRevenue bucket untouched.
        assertEq(vault.platformRevenue(address(token)), 60 ether);
    }

    function test_relayer_claim_skips_PlatformFeeFromRelayerClaim_when_fee_zero() public {
        // 0% platform fee → no skim, no event. Use a fresh vault with bps=0.
        FeeVault zeroFeeVault = ProxyDeployer.deployFeeVault(address(this), address(this), treasury, 0);
        zeroFeeVault.setAuthorizedDepositor(depositor, true);
        token.mint(address(zeroFeeVault), 10 ether);

        vm.prank(depositor);
        zeroFeeVault.deposit(relayer, address(token), 10 ether);

        // Record deposited topics so we can assert the skim event is absent.
        vm.recordLogs();
        vm.prank(relayer);
        zeroFeeVault.claim(address(token));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 skimTopic = FeeVault.PlatformFeeFromRelayerClaim.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != skimTopic, "skim event must not fire");
        }

        assertEq(token.balanceOf(relayer), 10 ether);
        assertEq(token.balanceOf(treasury), 0);
    }
}
