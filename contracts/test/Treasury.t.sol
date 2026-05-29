// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Treasury} from "../src/Treasury.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Always-reject ETH receiver used to exercise the EthTransferFailed path.
contract RejectETH {
    fallback() external payable {
        revert("nope");
    }
}

contract TreasuryTest is Test {
    Treasury internal treasury;
    MockERC20 internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");       // allowlisted beneficiary
    address internal bob = makeAddr("bob");           // NOT allowlisted
    address internal reporter_ = makeAddr("reporter"); // allowlisted reporter
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        treasury = ProxyDeployer.deployTreasury(owner, owner);
        token = new MockERC20();
        vm.startPrank(owner);
        treasury.setBeneficiary(alice, true);
        treasury.setReporter(reporter_, true);
        vm.stopPrank();
    }

    // ─── Initialize ──────────────────────────────────────────

    function test_initialize_setsOwner() public view {
        assertEq(treasury.owner(), owner);
    }

    function test_initialize_rejectsZeroOwner() public {
        Treasury impl = new Treasury();
        bytes memory initData = abi.encodeCall(Treasury.initialize, (address(0)));
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new ProxyEmitterForInitRevert(address(impl), owner, initData);
    }

    function test_renounceOwnership_reverts() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.RenounceOwnershipDisabled.selector);
        treasury.renounceOwnership();
    }

    // ─── Receive ETH ─────────────────────────────────────────

    function test_receive_bumpsCounter_andEmits() public {
        vm.deal(stranger, 5 ether);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit Treasury.Received(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok, ) = address(treasury).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(treasury.attributedETH(), 1 ether);
        assertEq(address(treasury).balance, 1 ether);
    }

    function test_receive_zeroValueIsNoOp() public {
        vm.prank(stranger);
        (bool ok, ) = address(treasury).call{value: 0}("");
        assertTrue(ok);
        assertEq(treasury.attributedETH(), 0);
    }

    // ─── setReporter / recordRevenue gating ──────────────────

    function test_setReporter_ownerCan() public {
        vm.expectEmit(true, false, false, true, address(treasury));
        emit Treasury.ReporterUpdated(stranger, true);
        vm.prank(owner);
        treasury.setReporter(stranger, true);
        assertTrue(treasury.reporter(stranger));
    }

    function test_setReporter_nonOwnerReverts() public {
        vm.prank(stranger);
        vm.expectRevert();
        treasury.setReporter(bob, true);
    }

    function test_setReporter_rejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.setReporter(address(0), true);
    }

    // ─── recordRevenue ───────────────────────────────────────

    function test_recordRevenue_bumpsCounter_andEmits() public {
        token.mint(address(treasury), 1_000);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit Treasury.SourcedRevenue(address(token), 1_000, "claim-skim");
        vm.prank(reporter_);
        treasury.recordRevenue(address(token), 1_000, "claim-skim");
        assertEq(treasury.attributedERC20(address(token)), 1_000);
    }

    function test_recordRevenue_nonReporterReverts() public {
        token.mint(address(treasury), 1_000);
        // The exact griefing vector Gemini flagged: a random address
        // tries to inflate the attributed counter to block rescue.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotReporter.selector, stranger));
        treasury.recordRevenue(address(token), 1_000, "rogue");
    }

    function test_recordRevenue_rejectsAmountAboveBalance() public {
        token.mint(address(treasury), 100);
        vm.prank(reporter_);
        vm.expectRevert(Treasury.AttributedExceedsBalance.selector);
        treasury.recordRevenue(address(token), 101, "claim-skim");
    }

    function test_recordRevenue_acceptsIncrementalRecordsUpToBalance() public {
        token.mint(address(treasury), 1_000);
        vm.startPrank(reporter_);
        treasury.recordRevenue(address(token), 600, "claim-skim");
        treasury.recordRevenue(address(token), 400, "dex-withdraw");
        assertEq(treasury.attributedERC20(address(token)), 1_000);
        vm.expectRevert(Treasury.AttributedExceedsBalance.selector);
        treasury.recordRevenue(address(token), 1, "claim-skim");
        vm.stopPrank();
    }

    function test_recordRevenue_rejectsZeroAmount() public {
        vm.prank(reporter_);
        vm.expectRevert(Treasury.ZeroAmount.selector);
        treasury.recordRevenue(address(token), 0, "claim-skim");
    }

    function test_recordRevenue_rejectsZeroToken() public {
        vm.prank(reporter_);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.recordRevenue(address(0), 1, "claim-skim");
    }

    // ─── setBeneficiary ──────────────────────────────────────

    function test_setBeneficiary_ownerCan() public {
        vm.expectEmit(true, false, false, true, address(treasury));
        emit Treasury.BeneficiaryUpdated(bob, true);
        vm.prank(owner);
        treasury.setBeneficiary(bob, true);
        assertTrue(treasury.beneficiary(bob));
    }

    function test_setBeneficiary_nonOwnerReverts() public {
        vm.prank(stranger);
        vm.expectRevert();
        treasury.setBeneficiary(bob, true);
    }

    function test_setBeneficiary_rejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.setBeneficiary(address(0), true);
    }

    // ─── withdraw (ERC20) ────────────────────────────────────

    function test_withdraw_allowlistedRecipient() public {
        token.mint(address(treasury), 1_000);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit Treasury.Withdrawn(address(token), alice, 600);
        vm.prank(owner);
        treasury.withdraw(address(token), alice, 600);
        assertEq(token.balanceOf(alice), 600);
        assertEq(token.balanceOf(address(treasury)), 400);
    }

    function test_withdraw_nonAllowlistedReverts() public {
        token.mint(address(treasury), 1_000);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAllowlisted.selector, bob));
        treasury.withdraw(address(token), bob, 100);
    }

    function test_withdraw_nonOwnerReverts() public {
        token.mint(address(treasury), 1_000);
        vm.prank(stranger);
        vm.expectRevert();
        treasury.withdraw(address(token), alice, 100);
    }

    function test_withdraw_exceedsBalanceReverts() public {
        token.mint(address(treasury), 100);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.InsufficientBalance.selector, 101, 100));
        treasury.withdraw(address(token), alice, 101);
    }

    function test_withdraw_rejectsZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(Treasury.ZeroAmount.selector);
        treasury.withdraw(address(token), alice, 0);
    }

    function test_withdraw_pausedReverts() public {
        token.mint(address(treasury), 1_000);
        vm.prank(owner);
        treasury.pause();
        vm.prank(owner);
        vm.expectRevert();
        treasury.withdraw(address(token), alice, 100);
    }

    /// @notice The exact DoS Gemini flagged as critical: counter
    ///         must drop on withdraw so the next `recordRevenue` /
    ///         `rescue` can still operate.
    function test_withdraw_decrementsAttributed_keepsCounterAlive() public {
        token.mint(address(treasury), 1_000);
        vm.prank(reporter_);
        treasury.recordRevenue(address(token), 1_000, "claim-skim");
        assertEq(treasury.attributedERC20(address(token)), 1_000);
        vm.prank(owner);
        treasury.withdraw(address(token), alice, 400);
        assertEq(treasury.attributedERC20(address(token)), 600);
        // recordRevenue still works after withdrawal
        token.mint(address(treasury), 200);
        vm.prank(reporter_);
        treasury.recordRevenue(address(token), 200, "dex-withdraw");
        assertEq(treasury.attributedERC20(address(token)), 800);
    }

    function test_withdraw_unattributedSliceFloorsAt0() public {
        // Stray transfer of 1_000 (un-attributed). Owner withdraws
        // 600 — attributed was 0 so should clamp to 0, not underflow.
        token.mint(address(treasury), 1_000);
        vm.prank(owner);
        treasury.withdraw(address(token), alice, 600);
        assertEq(treasury.attributedERC20(address(token)), 0);
    }

    // ─── withdrawETH ─────────────────────────────────────────

    function test_withdrawETH_allowlistedRecipient() public {
        vm.deal(address(treasury), 5 ether);
        uint256 aliceBefore = alice.balance;
        vm.expectEmit(true, false, false, true, address(treasury));
        emit Treasury.WithdrawnETH(alice, 1 ether);
        vm.prank(owner);
        treasury.withdrawETH(payable(alice), 1 ether);
        assertEq(alice.balance, aliceBefore + 1 ether);
        assertEq(address(treasury).balance, 4 ether);
    }

    function test_withdrawETH_nonAllowlistedReverts() public {
        vm.deal(address(treasury), 1 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAllowlisted.selector, bob));
        treasury.withdrawETH(payable(bob), 1 ether);
    }

    function test_withdrawETH_recipientRejects_surfacesEthTransferFailed() public {
        RejectETH bad = new RejectETH();
        vm.prank(owner);
        treasury.setBeneficiary(address(bad), true);
        vm.deal(address(treasury), 1 ether);
        vm.prank(owner);
        vm.expectRevert(Treasury.EthTransferFailed.selector);
        treasury.withdrawETH(payable(address(bad)), 1 ether);
    }

    function test_withdrawETH_pausedReverts() public {
        vm.deal(address(treasury), 1 ether);
        vm.prank(owner);
        treasury.pause();
        vm.prank(owner);
        vm.expectRevert();
        treasury.withdrawETH(payable(alice), 1 ether);
    }

    function test_withdrawETH_decrementsAttributed_keepsCounterAlive() public {
        // Send 2 ether via receive() — counter = 2 ether.
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        (bool sent, ) = address(treasury).call{value: 2 ether}("");
        assertTrue(sent);
        // Withdraw 1 ether. Counter must drop to 1 ether so
        // `rescueETH` and future `receive` calls still work.
        vm.prank(owner);
        treasury.withdrawETH(payable(alice), 1 ether);
        assertEq(treasury.attributedETH(), 1 ether);
    }

    // ─── rescue (ERC20) ──────────────────────────────────────

    function test_rescue_untaggedBalance() public {
        token.mint(address(treasury), 1_000);
        vm.prank(owner);
        treasury.rescue(address(token), alice, 1_000);
        assertEq(token.balanceOf(alice), 1_000);
    }

    function test_rescue_cannotEatTaggedRevenue() public {
        token.mint(address(treasury), 1_000);
        vm.prank(reporter_);
        treasury.recordRevenue(address(token), 700, "claim-skim");
        vm.prank(owner);
        treasury.rescue(address(token), alice, 300);
        assertEq(token.balanceOf(alice), 300);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.InsufficientBalance.selector, 1, 0));
        treasury.rescue(address(token), alice, 1);
    }

    function test_rescue_nonAllowlistedReverts() public {
        token.mint(address(treasury), 100);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAllowlisted.selector, bob));
        treasury.rescue(address(token), bob, 100);
    }

    function test_rescue_survivesWithdrawal() public {
        // Tag 600, leave 400 un-attributed. Withdraw 200 from
        // the tagged slice (attributed drops to 400, balance drops
        // to 800 — un-attributed slice still 400). Rescue must
        // still claw 400.
        token.mint(address(treasury), 1_000);
        vm.prank(reporter_);
        treasury.recordRevenue(address(token), 600, "claim-skim");
        vm.startPrank(owner);
        treasury.withdraw(address(token), alice, 200);
        assertEq(treasury.attributedERC20(address(token)), 400);
        treasury.rescue(address(token), alice, 400);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 600);
    }

    // ─── rescueETH ───────────────────────────────────────────

    function test_rescueETH_untaggedBalance() public {
        // `vm.deal` pushes ETH without firing receive() — simulating
        // a selfdestruct push. All of it is rescuable.
        vm.deal(address(treasury), 3 ether);
        vm.prank(owner);
        treasury.rescueETH(payable(alice), 3 ether);
        assertEq(alice.balance, 3 ether);
    }

    function test_rescueETH_cannotEatCountedReceive() public {
        // Honest receive of 2 ether bumps attributed.
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        (bool ok, ) = address(treasury).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(treasury.attributedETH(), 2 ether);
        // Stealth push lifts balance to 5 ether without touching
        // the counter — 3 ether rescuable.
        vm.deal(address(treasury), 5 ether);
        vm.prank(owner);
        treasury.rescueETH(payable(alice), 3 ether);
        assertEq(alice.balance, 3 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.InsufficientBalance.selector, 1, 0));
        treasury.rescueETH(payable(alice), 1);
    }

    function test_rescueETH_nonAllowlistedReverts() public {
        vm.deal(address(treasury), 1 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAllowlisted.selector, bob));
        treasury.rescueETH(payable(bob), 1 ether);
    }

    function test_rescueETH_survivesWithdrawal() public {
        // 2 ether via receive (attributed = 2). Push 3 more stealth.
        // Withdraw 1 (attributed → 1, balance → 4). Rescue surface
        // is balance − attributed = 3 ether. Still rescuable.
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        (bool ok, ) = address(treasury).call{value: 2 ether}("");
        assertTrue(ok);
        vm.deal(address(treasury), 5 ether);
        vm.startPrank(owner);
        treasury.withdrawETH(payable(alice), 1 ether);
        assertEq(treasury.attributedETH(), 1 ether);
        treasury.rescueETH(payable(alice), 3 ether);
        vm.stopPrank();
        assertEq(alice.balance, 4 ether);
    }

    // ─── pause / unpause ─────────────────────────────────────

    function test_pause_unpause_flow() public {
        token.mint(address(treasury), 1_000);
        vm.prank(owner);
        treasury.pause();
        assertTrue(treasury.paused());
        vm.prank(owner);
        treasury.unpause();
        assertFalse(treasury.paused());
        vm.prank(owner);
        treasury.withdraw(address(token), alice, 100);
        assertEq(token.balanceOf(alice), 100);
    }

    function test_pause_nonOwnerReverts() public {
        vm.prank(stranger);
        vm.expectRevert();
        treasury.pause();
    }
}

/// @dev Trivial proxy stand-in used only to surface the initializer
///      revert in `test_initialize_rejectsZeroOwner`. Inlined here so
///      the test file stays self-contained.
contract ProxyEmitterForInitRevert {
    constructor(address impl, address /*admin*/, bytes memory initData) payable {
        (bool ok, bytes memory ret) = impl.delegatecall(initData);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
