// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {FeeVault} from "../../src/FeeVault.sol";

/// @dev Minimal mintable ERC20 used as the fee token in invariant runs.
contract InvariantToken is ERC20 {
    constructor() ERC20("Invariant Token", "INV") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Actor-based handler for FeeVault invariant tests.
/// @dev    Routes fuzzed actions through a small set of relayers/depositors so the
///         invariant runner can stress fee accounting under arbitrary call orderings.
contract FeeVaultHandler is CommonBase, StdCheats, StdUtils {
    FeeVault public immutable vault;
    InvariantToken public immutable token;
    address public immutable owner;
    address public immutable treasury;

    address[] public relayers;
    address[] public depositors;

    /// @dev Mirror of FeeVault.balances used to cross-check the sum invariant
    ///      without iterating private mapping storage from the test.
    mapping(address => uint256) public ghostBalance;
    uint256 public ghostTotalBalances;
    uint256 public ghostPlatformRevenue;
    uint256 public ghostTreasuryReceived;

    /// @dev Selector-invocation counters for the adversarial actions
    ///      (incremented at function entry, before any early-return).
    ///      `afterInvariant` reads these to prove the selectors stayed
    ///      wired in the campaign.
    uint256 public adversarialUnauthorizedDepositAttempts;
    uint256 public adversarialEmptyClaimAttempts;
    uint256 public adversarialUnauthorizedWithdrawAttempts;

    constructor(FeeVault _vault, InvariantToken _token, address _owner, address _treasury) {
        vault = _vault;
        token = _token;
        owner = _owner;
        treasury = _treasury;

        for (uint160 i = 1; i <= 5; ++i) {
            relayers.push(address(uint160(0xA000 + i)));
        }
        for (uint160 i = 1; i <= 3; ++i) {
            address d = address(uint160(0xD000 + i));
            depositors.push(d);
            vm.prank(_owner);
            _vault.setAuthorizedDepositor(d, true);
        }
    }

    // ─── Action: deposit fee for a relayer ──────────────────────
    function deposit(uint256 relayerSeed, uint256 depositorSeed, uint256 amount) external {
        amount = bound(amount, 0, 1e24);
        address relayer = relayers[relayerSeed % relayers.length];
        address depositor = depositors[depositorSeed % depositors.length];

        // Pre-fund the vault so _assertBalanceBacked passes.
        token.mint(address(vault), amount);

        vm.prank(depositor);
        vault.deposit(relayer, address(token), amount);

        ghostBalance[relayer] += amount;
        ghostTotalBalances += amount;
    }

    // ─── Action: accrue platform revenue (DEX fee path) ─────────
    function accrueDexFee(uint256 depositorSeed, uint256 amount) external {
        amount = bound(amount, 0, 1e24);
        address depositor = depositors[depositorSeed % depositors.length];
        token.mint(address(vault), amount);

        vm.prank(depositor);
        vault.accrueDexFee(address(token), amount);

        ghostPlatformRevenue += amount;
    }

    // ─── Action: claim relayer fee ──────────────────────────────
    function claim(uint256 relayerSeed) external {
        address relayer = relayers[relayerSeed % relayers.length];
        uint256 balance = ghostBalance[relayer];
        if (balance == 0) return;

        uint256 platformFee = (balance * vault.platformFeeBps()) / 10000;

        vm.prank(relayer);
        vault.claim(address(token));

        ghostBalance[relayer] = 0;
        ghostTotalBalances -= balance;
        ghostTreasuryReceived += platformFee;
    }

    // ─── Action: treasury withdraws platform revenue ────────────
    function withdrawPlatformRevenue() external {
        if (ghostPlatformRevenue == 0) return;
        uint256 amt = ghostPlatformRevenue;
        vm.prank(treasury);
        vault.withdrawPlatformRevenue(address(token));
        ghostPlatformRevenue -= amt;
        ghostTreasuryReceived += amt;
    }

    // ─── Action: schedule + apply fee change ────────────────────
    function scheduleFeeChange(uint256 bps) external {
        bps = bound(bps, 0, vault.MAX_PLATFORM_FEE());
        vm.prank(owner);
        vault.scheduleFeeChange(bps);
    }

    function applyFeeChange() external {
        uint256 eff = vault.pendingFeeEffectiveTime();
        if (eff == 0) return;
        if (block.timestamp < eff) vm.warp(eff);
        vm.prank(owner);
        vault.applyFeeChange();
    }

    function relayerAt(uint256 i) external view returns (address) {
        return relayers[i % relayers.length];
    }

    function relayerCount() external view returns (uint256) {
        return relayers.length;
    }

    // ─── Adversarial actions ────────────────────────────────────
    //
    // Each must reach the contract and trigger the expected guard. The
    // try/catch shape mirrors the non-adversarial actions but the body
    // intentionally inverts the assertion: success would mean the
    // guard is broken. Counters increment before any early return so
    // `afterInvariant` measures selector invocations, not "attempts
    // that found preconditions" — same lesson as PR #718 review.

    /// @notice A random EOA tries to deposit. FeeVault.deposit gates on
    ///         `authorizedDepositors[msg.sender]`; any other caller must
    ///         revert with NotAuthorized. Succeeding would credit a
    ///         relayer's balance without the vault holding the tokens
    ///         (`_assertBalanceBacked` would also catch that, but the
    ///         authorization guard is the first line of defense).
    function adversarialUnauthorizedDeposit(uint256 relayerSeed, uint256 amount) external {
        adversarialUnauthorizedDepositAttempts += 1;
        amount = bound(amount, 1, 1e24);
        address relayer = relayers[relayerSeed % relayers.length];
        address eoa = address(uint160(0xE0A0)); // never registered as a depositor
        // Pre-fund so an accidentally-permissive deposit wouldn't fail
        // for the wrong reason (`_assertBalanceBacked`); we want to
        // prove the authorization check itself rejected the call.
        token.mint(address(vault), amount);
        vm.prank(eoa);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.deposit(relayer, address(token), amount);
    }

    /// @notice Relayer with zero balance calls claim(). FeeVault.claim
    ///         reverts with NothingToClaim when balance == 0. Succeeding
    ///         would imply the balance accounting / mapping is corrupted.
    function adversarialEmptyClaim(uint256 relayerSeed) external {
        adversarialEmptyClaimAttempts += 1;
        address relayer = relayers[relayerSeed % relayers.length];
        if (ghostBalance[relayer] != 0) return; // not an empty-claim attempt
        uint256 balBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claim(address(token));
        require(token.balanceOf(relayer) == balBefore, "invariant violation: empty claim moved tokens");
    }

    /// @notice Random EOA tries to drain platform revenue. Must revert
    ///         specifically with `NotAuthorized` — a generic catch would
    ///         miss an auth-bypass regression that left the call reverting
    ///         on `NothingToClaim` instead (when `platformRevenue == 0`).
    ///         Pre-accrue revenue so the call would otherwise succeed for
    ///         a legitimate caller; assert the precise revert selector.
    function adversarialUnauthorizedWithdraw(uint256 amount) external {
        adversarialUnauthorizedWithdrawAttempts += 1;
        amount = bound(amount, 1, 1e22);
        // Pre-fund so a hypothetical auth-bypass would actually move
        // tokens — without this, NothingToClaim would mask the bug.
        token.mint(address(vault), amount);
        address allowedDepositor = depositors[0];
        vm.prank(allowedDepositor);
        vault.accrueDexFee(address(token), amount);
        ghostPlatformRevenue += amount;

        address eoa = address(uint160(0xE0A1));
        vm.prank(eoa);
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        vault.withdrawPlatformRevenue(address(token));
    }
}
