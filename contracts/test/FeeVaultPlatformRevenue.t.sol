// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FeeVault} from "../src/FeeVault.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MCK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
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

    bytes32 constant SOURCE_SURPLUS = keccak256("market-surplus");
    bytes32 constant SOURCE_PLATFORM_FEE = keccak256("market-platform-fee");

    function setUp() public {
        vault = new FeeVault(treasury, 500); // 5% relayer-claim platform fee (separate bucket)
        token = new MockERC20();
        vault.setAuthorizedDepositor(depositor, true);
    }

    // ─── depositPlatformRevenue: happy path ─────────────────────

    function test_depositPlatformRevenue_credits_bucket_and_emits() public {
        token.mint(address(vault), 100 ether);

        vm.expectEmit(true, false, true, true);
        emit FeeVault.PlatformRevenueDeposited(address(token), 100 ether, SOURCE_SURPLUS);

        vm.prank(depositor);
        vault.depositPlatformRevenue(address(token), 100 ether, SOURCE_SURPLUS);

        assertEq(vault.platformRevenue(address(token)), 100 ether);
        // Relayer balances are unaffected — platformRevenue is a separate ledger.
        assertEq(vault.balances(relayer, address(token)), 0);
        assertEq(vault.totalTracked(address(token)), 0);
    }

    function test_depositPlatformRevenue_accumulates_across_sources() public {
        token.mint(address(vault), 30 ether);

        vm.startPrank(depositor);
        vault.depositPlatformRevenue(address(token), 10 ether, SOURCE_PLATFORM_FEE);
        vault.depositPlatformRevenue(address(token), 20 ether, SOURCE_SURPLUS);
        vm.stopPrank();

        assertEq(vault.platformRevenue(address(token)), 30 ether);
    }

    function test_depositPlatformRevenue_zero_amount_is_noop() public {
        vm.prank(depositor);
        vault.depositPlatformRevenue(address(token), 0, SOURCE_SURPLUS);
        assertEq(vault.platformRevenue(address(token)), 0);
    }

    // ─── depositPlatformRevenue: authorization ──────────────────

    function test_depositPlatformRevenue_reverts_if_unauthorized() public {
        token.mint(address(vault), 1 ether);
        vm.prank(outsider);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.depositPlatformRevenue(address(token), 1 ether, SOURCE_SURPLUS);
    }

    function test_depositPlatformRevenue_reverts_if_deauthorized() public {
        vault.setAuthorizedDepositor(depositor, false);
        token.mint(address(vault), 1 ether);
        vm.prank(depositor);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.depositPlatformRevenue(address(token), 1 ether, SOURCE_SURPLUS);
    }

    function test_depositPlatformRevenue_reverts_if_zero_token() public {
        vm.prank(depositor);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.depositPlatformRevenue(address(0), 1 ether, SOURCE_SURPLUS);
    }

    // ─── balance invariant: prevents crediting without backing transfer ──

    function test_depositPlatformRevenue_reverts_when_vault_underfunded() public {
        // No mint — vault holds 0 tokens. Crediting 1 ether should revert.
        vm.prank(depositor);
        vm.expectRevert(FeeVault.InsufficientTokenBalance.selector);
        vault.depositPlatformRevenue(address(token), 1 ether, SOURCE_SURPLUS);
    }

    function test_depositPlatformRevenue_invariant_couples_with_relayer_balances() public {
        // Vault holds 100. 60 credited to relayer first; remaining 40 covers
        // up to 40 platform revenue. Going over MUST revert.
        token.mint(address(vault), 100 ether);
        vm.prank(depositor);
        vault.deposit(relayer, address(token), 60 ether);

        vm.prank(depositor);
        vault.depositPlatformRevenue(address(token), 40 ether, SOURCE_SURPLUS);
        assertEq(vault.platformRevenue(address(token)), 40 ether);

        vm.prank(depositor);
        vm.expectRevert(FeeVault.InsufficientTokenBalance.selector);
        vault.depositPlatformRevenue(address(token), 1, SOURCE_SURPLUS);
    }

    function test_deposit_relayer_invariant_couples_with_platform_revenue() public {
        // Inverse: platform revenue must not let the relayer-deposit path
        // over-commit the same underlying balance.
        token.mint(address(vault), 100 ether);

        vm.prank(depositor);
        vault.depositPlatformRevenue(address(token), 40 ether, SOURCE_SURPLUS);

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
        vault.depositPlatformRevenue(address(token), 100 ether, SOURCE_SURPLUS);

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
        vault.depositPlatformRevenue(address(token), 50 ether, SOURCE_SURPLUS);

        // Owner is the deployer (this contract); it still sends to treasury,
        // never to msg.sender.
        vault.withdrawPlatformRevenue(address(token));
        assertEq(token.balanceOf(treasury), 50 ether);
        assertEq(vault.platformRevenue(address(token)), 0);
    }

    function test_withdrawPlatformRevenue_reverts_if_unauthorized() public {
        token.mint(address(vault), 10 ether);
        vm.prank(depositor);
        vault.depositPlatformRevenue(address(token), 10 ether, SOURCE_SURPLUS);

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
        vault.depositPlatformRevenue(address(token), 10 ether, SOURCE_SURPLUS);

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

    // ─── relayer claim path is not affected ─────────────────────

    function test_relayer_claim_ignores_platform_revenue() public {
        // Setup: 100 backing balance. Credit 40 to relayer + 60 to platform.
        token.mint(address(vault), 100 ether);
        vm.startPrank(depositor);
        vault.deposit(relayer, address(token), 40 ether);
        vault.depositPlatformRevenue(address(token), 60 ether, SOURCE_SURPLUS);
        vm.stopPrank();

        // Relayer claims 40 — loses 5% platform fee to treasury, keeps 38.
        vm.prank(relayer);
        vault.claim(address(token));

        assertEq(vault.balances(relayer, address(token)), 0);
        assertEq(token.balanceOf(relayer), 38 ether);
        assertEq(token.balanceOf(treasury), 2 ether); // 5% of 40

        // platformRevenue bucket untouched.
        assertEq(vault.platformRevenue(address(token)), 60 ether);
    }
}
