// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FeeVaultTimelockTest is Test {
    FeeVault public vault;
    MockERC20 public token;

    address treasury = address(0xCAFE);
    address relayer = address(0xBEEF);
    address depositor = address(0xDEAD);

    function setUp() public {
        vault = ProxyDeployer.deployFeeVault(address(this), address(this), treasury, 500); // 5% initial
        token = new MockERC20();

        vault.setAuthorizedDepositor(depositor, true);

        // Fund vault: depositor credits 100 tokens to relayer
        token.mint(address(vault), 100 ether);
        vm.prank(depositor);
        vault.deposit(relayer, address(token), 100 ether);
    }

    // ─── scheduleFeeChange ──────────────────────────────────────

    function test_scheduleFeeChange_sets_pending() public {
        vault.scheduleFeeChange(1000);

        assertEq(vault.pendingFeeBps(), 1000);
        assertEq(vault.pendingFeeEffectiveTime(), block.timestamp + vault.feeChangeDelay());
        // Current fee unchanged
        assertEq(vault.platformFeeBps(), 500);
    }

    function test_scheduleFeeChange_emits_event() public {
        vm.expectEmit(true, true, true, true);
        emit FeeVault.FeeChangeScheduled(500, 1000, block.timestamp + vault.feeChangeDelay());
        vault.scheduleFeeChange(1000);
    }

    function test_scheduleFeeChange_reverts_if_too_high() public {
        vm.expectRevert(FeeVault.FeeTooHigh.selector);
        vault.scheduleFeeChange(5001);
    }

    function test_scheduleFeeChange_reverts_if_not_owner() public {
        vm.prank(relayer);
        vm.expectRevert();
        vault.scheduleFeeChange(1000);
    }

    // ─── applyFeeChange ─────────────────────────────────────────

    function test_applyFeeChange_after_delay() public {
        vault.scheduleFeeChange(1000);
        vm.warp(block.timestamp + vault.feeChangeDelay());
        vault.applyFeeChange();

        assertEq(vault.platformFeeBps(), 1000);
        assertEq(vault.pendingFeeBps(), 0);
        assertEq(vault.pendingFeeEffectiveTime(), 0);
    }

    function test_applyFeeChange_reverts_before_delay() public {
        vault.scheduleFeeChange(1000);
        vm.warp(block.timestamp + vault.feeChangeDelay() - 1); // 1 second early

        vm.expectRevert(FeeVault.FeeChangeNotReady.selector);
        vault.applyFeeChange();
    }

    function test_applyFeeChange_reverts_if_no_pending() public {
        vm.expectRevert(FeeVault.NoFeeChangePending.selector);
        vault.applyFeeChange();
    }

    function test_applyFeeChange_emits_event() public {
        vault.scheduleFeeChange(1000);
        vm.warp(block.timestamp + vault.feeChangeDelay());

        vm.expectEmit(true, true, true, true);
        emit FeeVault.PlatformFeeUpdated(500, 1000);
        vault.applyFeeChange();
    }

    // ─── cancelFeeChange ────────────────────────────────────────

    function test_cancelFeeChange() public {
        vault.scheduleFeeChange(1000);
        vault.cancelFeeChange();

        assertEq(vault.pendingFeeBps(), 0);
        assertEq(vault.pendingFeeEffectiveTime(), 0);
        assertEq(vault.platformFeeBps(), 500); // unchanged
    }

    function test_cancelFeeChange_emits_event() public {
        vault.scheduleFeeChange(1000);

        vm.expectEmit(true, true, true, true);
        emit FeeVault.FeeChangeCancelled(1000);
        vault.cancelFeeChange();
    }

    function test_cancelFeeChange_reverts_if_no_pending() public {
        vm.expectRevert(FeeVault.NoFeeChangePending.selector);
        vault.cancelFeeChange();
    }

    // ─── Front-run protection (core scenario) ───────────────────

    function test_claim_during_pending_uses_old_fee() public {
        // Owner schedules fee increase from 5% to 20%
        vault.scheduleFeeChange(2000);

        // Relayer sees the pending change and claims immediately at the old 5% rate
        vm.prank(relayer);
        vault.claim(address(token));

        // Relayer gets 95 tokens (100 - 5%), treasury gets 5 tokens
        assertEq(token.balanceOf(relayer), 95 ether, "relayer gets 95%");
        assertEq(token.balanceOf(treasury), 5 ether, "treasury gets 5%");
    }

    function test_frontrun_blocked_claim_after_apply_uses_new_fee() public {
        // Relayer claims first batch at old 5% rate
        vm.prank(relayer);
        vault.claim(address(token));
        assertEq(token.balanceOf(relayer), 95 ether, "first claim at 5%");

        // Owner schedules and applies fee increase
        vault.scheduleFeeChange(2000); // 20%
        vm.warp(block.timestamp + vault.feeChangeDelay());
        vault.applyFeeChange();

        // Fund and deposit new fees after the fee change
        token.mint(address(vault), 100 ether);
        vm.prank(depositor);
        vault.deposit(relayer, address(token), 100 ether);

        // Relayer claims at new 20% rate
        vm.prank(relayer);
        vault.claim(address(token));
        // Second claim: 100 - 20% = 80 tokens
        assertEq(token.balanceOf(relayer), 95 ether + 80 ether, "second claim at 20%");
    }

    // ─── Fee change to zero ─────────────────────────────────────

    function test_scheduleFeeChange_to_zero() public {
        vault.scheduleFeeChange(0);
        vm.warp(block.timestamp + vault.feeChangeDelay());
        vault.applyFeeChange();

        assertEq(vault.platformFeeBps(), 0);

        vm.prank(relayer);
        vault.claim(address(token));

        assertEq(token.balanceOf(relayer), 100 ether, "no fee deducted");
        assertEq(token.balanceOf(treasury), 0, "no fee to treasury");
    }

    // ─── Overwrite pending change ───────────────────────────────

    function test_schedule_overwrites_previous_pending() public {
        vault.scheduleFeeChange(1000);
        vault.scheduleFeeChange(2000);

        assertEq(vault.pendingFeeBps(), 2000);

        vm.warp(block.timestamp + vault.feeChangeDelay());
        vault.applyFeeChange();
        assertEq(vault.platformFeeBps(), 2000);
    }

    // ─── Configurable fee-change delay ──────────────────────────

    event FeeChangeDelayUpdated(uint256 oldDelay, uint256 newDelay);

    function test_feeChangeDelay_defaults_to_1_day() public view {
        assertEq(vault.feeChangeDelay(), 1 days);
        assertEq(vault.feeChangeDelay(), vault.DEFAULT_FEE_CHANGE_DELAY());
    }

    function test_setFeeChangeDelay_updates_and_emits() public {
        vm.expectEmit(false, false, false, true);
        emit FeeChangeDelayUpdated(1 days, 3 days);
        vault.setFeeChangeDelay(3 days);
        assertEq(vault.feeChangeDelay(), 3 days);
    }

    function test_setFeeChangeDelay_only_owner_reverts() public {
        vm.prank(relayer);
        vm.expectRevert();
        vault.setFeeChangeDelay(3 days);
    }

    function test_setFeeChangeDelay_above_cap_reverts() public {
        uint256 tooLong = vault.MAX_FEE_CHANGE_DELAY() + 1;
        vm.expectRevert(FeeVault.DelayTooLong.selector);
        vault.setFeeChangeDelay(tooLong);
    }

    function test_setFeeChangeDelay_at_cap_allowed() public {
        vault.setFeeChangeDelay(vault.MAX_FEE_CHANGE_DELAY());
        assertEq(vault.feeChangeDelay(), 30 days);
    }

    /// @dev A new delay applies to the NEXT schedule; the timelock window moves.
    function test_setFeeChangeDelay_applies_to_next_schedule() public {
        vault.setFeeChangeDelay(2 days);
        uint256 t0 = block.timestamp;
        vault.scheduleFeeChange(1000);
        assertEq(vault.pendingFeeEffectiveTime(), t0 + 2 days);

        // Not ready after the old 1-day window…
        vm.warp(t0 + 1 days);
        vm.expectRevert(FeeVault.FeeChangeNotReady.selector);
        vault.applyFeeChange();

        // …ready after the new 2-day window.
        vm.warp(t0 + 2 days);
        vault.applyFeeChange();
        assertEq(vault.platformFeeBps(), 1000);
    }

    /// @dev delay=0 → a scheduled change is applyable in the same block.
    function test_setFeeChangeDelay_zero_allows_immediate_apply() public {
        vault.setFeeChangeDelay(0);
        vault.scheduleFeeChange(1000);
        assertEq(vault.pendingFeeEffectiveTime(), block.timestamp);
        vault.applyFeeChange();
        assertEq(vault.platformFeeBps(), 1000);
    }

    /// @dev Changing the delay does NOT move an ALREADY-pending change's deadline.
    function test_setFeeChangeDelay_does_not_move_existing_pending() public {
        uint256 t0 = block.timestamp;
        vault.scheduleFeeChange(1000); // locks effectiveTime = t0 + 1 day
        vault.setFeeChangeDelay(10 days); // must NOT affect the pending one
        assertEq(vault.pendingFeeEffectiveTime(), t0 + 1 days);
        vm.warp(t0 + 1 days);
        vault.applyFeeChange();
        assertEq(vault.platformFeeBps(), 1000);
    }
}
