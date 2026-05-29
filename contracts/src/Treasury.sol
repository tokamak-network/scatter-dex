// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  Treasury
/// @notice On-chain landing pad for the platform's accumulated revenue.
///         Receives platform-fee skims from `FeeVault` (relayer-claim
///         direct send + DEX-path withdrawals), holds them as ERC20
///         and native ETH balances, and lets the owner — expected to
///         be an external multisig (Safe) in production — withdraw to
///         a small, pre-registered allowlist of beneficiary addresses.
///
/// @dev    Design constraints picked to keep this small and auditable:
///         - **Single-owner model.** The owner is an external multisig
///           contract (set as the platform's Safe in production). No
///           in-contract N-of-M signature aggregation — Safe is the
///           industry standard and re-implementing it here would only
///           expand the attack surface.
///         - **Allowlist-gated withdraw.** `withdraw{,ETH}` checks the
///           destination against `beneficiary[addr] == true`. A key
///           compromise of the owner can only drain funds to addresses
///           that the same owner pre-registered — capping blast radius
///           when the multisig's policy lags behind a hot-wallet leak.
///         - **Pausable.** Owner can freeze every withdraw path during
///           an incident.
///         - **No timelock, no per-token rate limits.** Both deliberately
///           skipped per the PR design notes: the production owner is a
///           Safe with its own internal review cadence (timelock would
///           double-bill), and there is no automated sweep bot today
///           (rate limits would be dead weight). Either can be added
///           in a future upgrade via the `__gap` slots.
///         - **Receive-only counters.** `totalReceivedERC20[token]` and
///           `totalReceivedETH` are bumped by an explicit
///           `recordRevenue` hook FeeVault is expected to call right
///           after each platform-fee transfer (post-MVP wiring; today
///           this contract just counts what reaches it via plain
///           transfers and tags it "unattributed"). The split between
///           "claim-skim" / "DEX-withdraw" / "rescue" sources lives in
///           the SourcedRevenue event tag so off-chain indexers can
///           rebuild per-source totals without a per-source on-chain
///           counter (cheaper, keeps storage layout small).
///         - **Upgradeable.** Mirrors `FeeVault`'s
///           Initializable + Ownable2Step + ReentrancyGuard pattern so
///           the project's ProxyAdmin tooling treats both contracts
///           identically.
contract Treasury is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Storage ────────────────────────────────────────────────

    /// @notice Addresses permitted as `to` on every `withdraw{,ETH}` call.
    /// @dev    `to` must be in this map at call time. The owner — a Safe
    ///         in production — maintains the list out of band; this
    ///         contract only enforces it.
    mapping(address => bool) public beneficiary;

    /// @notice Addresses allowed to call `recordRevenue`. Owner-curated.
    ///         A permissionless `recordRevenue` was a griefing vector:
    ///         any caller could inflate `attributedERC20[token]` up to
    ///         the on-chain balance, blocking `rescue` of accidentally-
    ///         sent tokens and polluting the `SourcedRevenue` event log
    ///         with arbitrary `source` strings. The allowlist makes
    ///         `source` a trusted signal (only callers the owner has
    ///         vetted can stamp tags) and protects `rescue`.
    mapping(address => bool) public reporter;

    /// @notice ERC20 balance currently held that has been explicitly
    ///         "attributed" via `recordRevenue` — i.e. the slice of
    ///         the on-chain balance the platform considers tagged
    ///         revenue rather than an un-attributed stray transfer.
    ///         Bumped by `recordRevenue`, decremented by `withdraw`
    ///         (with a floor of zero so this never underflows when
    ///         the owner withdraws more than was attributed, e.g.
    ///         clearing a stray-deposit balance via `withdraw` after
    ///         tagging it).
    mapping(address => uint256) public attributedERC20;

    /// @notice Native ETH counterpart of `attributedERC20`. Bumped by
    ///         the `receive()` fallback (an explicit push from a
    ///         caller, e.g. `FeeVault.claimAsEth`), decremented by
    ///         `withdrawETH`. Native ETH has no per-token dimension
    ///         so a single scalar suffices.
    uint256 public attributedETH;

    /// @dev Reserved storage for future upgrades — same pattern as
    ///      `RelayerRegistry`. Decrement when new state lands.
    uint256[46] private __gap;

    // ─── Events ─────────────────────────────────────────────────

    event BeneficiaryUpdated(address indexed addr, bool allowed);
    event ReporterUpdated(address indexed addr, bool allowed);
    /// @notice Fired when ERC20 revenue is explicitly tagged via
    ///         `recordRevenue`. The `source` string lets off-chain
    ///         indexers split totals (e.g. "claim-skim" vs
    ///         "dex-withdraw") without per-source on-chain counters.
    event SourcedRevenue(address indexed token, uint256 amount, string source);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event WithdrawnETH(address indexed to, uint256 amount);
    event Received(address indexed from, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotAllowlisted(address to);
    error NotReporter(address caller);
    error InsufficientBalance(uint256 requested, uint256 available);
    error EthTransferFailed();
    error RenounceOwnershipDisabled();
    error AttributedExceedsBalance();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
    }

    /// @dev Blocks the inherited renounce path — a renounced treasury
    ///      is a permanently-frozen treasury (no way to authorise
    ///      future withdraws, allowlist updates, or unpause).
    function renounceOwnership() public pure override(OwnableUpgradeable) {
        revert RenounceOwnershipDisabled();
    }

    // ─── Receive ────────────────────────────────────────────────

    /// @notice Accept native ETH (used by `FeeVault.claimAsEth` when a
    ///         relayer claims a WETH-denominated balance as native
    ///         ETH). Updates the counter so off-chain audit doesn't
    ///         have to scrape `Transfer` events for ETH.
    receive() external payable {
        if (msg.value > 0) {
            attributedETH += msg.value;
            emit Received(msg.sender, msg.value);
        }
    }

    // ─── Inflow tagging ─────────────────────────────────────────

    /// @notice Tag an already-arrived ERC20 deposit with a source
    ///         string + bump the per-token attributed counter. Caller
    ///         MUST have transferred `amount` of `token` to this
    ///         contract first; this function only records, it doesn't
    ///         pull.
    /// @dev    Reporter-only. A permissionless `recordRevenue` was a
    ///         griefing vector: any caller could inflate the attributed
    ///         counter up to the on-chain balance, blocking `rescue` of
    ///         accidentally-sent tokens and polluting the
    ///         `SourcedRevenue` event log with arbitrary `source` tags.
    ///         The allowlist makes `source` a trusted signal and
    ///         keeps the rescue surface intact. `nonReentrant` is
    ///         defence in depth: a malicious `balanceOf` can't re-enter
    ///         to race the counter write past the just-read balance.
    ///
    ///         The balance floor `attributedERC20 + amount <= onHand`
    ///         pairs with `withdraw`'s symmetric decrement to keep the
    ///         invariant `attributedERC20[token] <= balanceOf(this)`
    ///         true after every state transition.
    function recordRevenue(address token, uint256 amount, string calldata source) external nonReentrant {
        if (!reporter[msg.sender]) revert NotReporter(msg.sender);
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 onHand = IERC20(token).balanceOf(address(this));
        if (attributedERC20[token] + amount > onHand) {
            revert AttributedExceedsBalance();
        }
        attributedERC20[token] += amount;
        emit SourcedRevenue(token, amount, source);
    }

    // ─── Withdraw ───────────────────────────────────────────────

    /// @notice Withdraw ERC20 to an allowlisted address. Owner-only +
    ///         allowlist-gated + pausable. Does NOT decrement the
    ///         received-counter — that's a cumulative inflow metric,
    ///         not a "balance available to withdraw" number.
    function withdraw(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!beneficiary[to]) revert NotAllowlisted(to);
        uint256 onHand = IERC20(token).balanceOf(address(this));
        if (amount > onHand) revert InsufficientBalance(amount, onHand);
        // Keep the `attributedERC20[token] <= balanceOf(this)`
        // invariant under withdrawal. Without this, the counter
        // stays cumulative while the balance falls, and the next
        // `recordRevenue` or `rescue` permanently reverts. Floor at
        // zero so a withdraw that exceeds the attributed slice
        // (e.g. owner clearing a stray-token balance after rescue
        // tagging) doesn't underflow.
        uint256 attributed = attributedERC20[token];
        attributedERC20[token] = attributed > amount ? attributed - amount : 0;
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Withdraw native ETH to an allowlisted address. Same
    ///         gating as `withdraw`.
    function withdrawETH(address payable to, uint256 amount)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!beneficiary[to]) revert NotAllowlisted(to);
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);
        // Symmetric with `withdraw`: keep `attributedETH <= balance`
        // so `rescueETH` and future `recordRevenue`-style ETH hooks
        // stay live after withdrawals.
        uint256 attributed = attributedETH;
        attributedETH = attributed > amount ? attributed - amount : 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit WithdrawnETH(to, amount);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setBeneficiary(address addr, bool allowed) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();
        beneficiary[addr] = allowed;
        emit BeneficiaryUpdated(addr, allowed);
    }

    /// @notice Add or remove a permitted `recordRevenue` caller.
    ///         Production wiring: the platform's `FeeVault` (and
    ///         eventually `PrivateSettlement`) should be the only
    ///         allowlisted reporters so the `source` tag on
    ///         `SourcedRevenue` events is trustworthy and the rescue
    ///         surface stays intact.
    function setReporter(address addr, bool allowed) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();
        reporter[addr] = allowed;
        emit ReporterUpdated(addr, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover native ETH that bypassed `receive()` and so
    ///         is missing from `totalReceivedETH` — typically a
    ///         `selfdestruct` push (which doesn't fire `receive`),
    ///         or a pre-EIP-7480 forced send. Only the un-counted
    ///         slice (balance above `totalReceivedETH`) is
    ///         rescue-eligible, so this can't cannibalise legitimate
    ///         platform revenue. Same allowlist gate as
    ///         `withdrawETH`.
    function rescueETH(address payable to, uint256 amount)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!beneficiary[to]) revert NotAllowlisted(to);
        uint256 onHand = address(this).balance;
        uint256 attributed = attributedETH;
        uint256 rescuable = onHand > attributed ? onHand - attributed : 0;
        if (amount > rescuable) revert InsufficientBalance(amount, rescuable);
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit Rescued(address(0), to, amount);
    }

    /// @notice Recover tokens that bypassed `recordRevenue` — sent
    ///         here by mistake, or as part of a token migration the
    ///         owner wants to rescue. Only the un-counted slice (the
    ///         portion above `totalReceivedERC20[token]`) is
    ///         retrievable, so this can never cannibalise tracked
    ///         platform revenue. Same allowlist gate as `withdraw`.
    function rescue(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!beneficiary[to]) revert NotAllowlisted(to);
        uint256 onHand = IERC20(token).balanceOf(address(this));
        uint256 attributed = attributedERC20[token];
        // The slice above the attributed amount is un-tagged; only
        // that slice is rescue-eligible. attributed >= onHand means
        // every token here was deliberately tagged via
        // recordRevenue, so the rescue surface is empty.
        uint256 rescuable = onHand > attributed ? onHand - attributed : 0;
        if (amount > rescuable) revert InsufficientBalance(amount, rescuable);
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }
}
