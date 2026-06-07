// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal WETH9 surface so relayer claims paid in WETH can be auto-
///      unwrapped to native ETH. Only the two functions we use here are
///      declared; full WETH ABI is irrelevant to FeeVault.
interface IWETH9 {
    function withdraw(uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}

/// @title FeeVault
/// @notice Accumulates settlement fees for relayers and deducts a platform fee on withdrawal.
///         PrivateSettlement deposits fees here during settle/scatterDirect.
///         Relayers claim their earned fees; platform fee (in bps) is deducted and sent to treasury.
contract FeeVault is Initializable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ─── State ──────────────────────────────────────────────────
    /// @notice Accumulated fee balance per relayer per token.
    mapping(address => mapping(address => uint256)) public balances;

    /// @notice Total tracked liabilities per token (sum of all relayer balances).
    mapping(address => uint256) public totalTracked;

    /// @notice Revenue accumulated from market-order platform fees and
    ///         positive-slippage surplus (settleWithDex). Tracked per token,
    ///         independently from relayer `balances`. Withdrawn by treasury.
    mapping(address => uint256) public platformRevenue;

    /// @notice Platform fee in basis points (e.g., 500 = 5%). Max 50%.
    uint256 public platformFeeBps;
    uint256 public constant MAX_PLATFORM_FEE = 5000; // 50%

    /// @notice Timelock delay for fee changes (prevents front-running relayer claims).
    uint256 public constant FEE_CHANGE_DELAY = 1 days;

    /// @notice Pending fee change (timelock).
    uint256 public pendingFeeBps;
    uint256 public pendingFeeEffectiveTime;

    /// @notice Treasury address that receives platform fees.
    address public treasury;

    /// @notice Only authorized depositors (PrivateSettlement) can credit fees.
    mapping(address => bool) public authorizedDepositors;

    /// @notice WETH address used to auto-unwrap relayer claims into native ETH.
    ///         When `claim(token)` is invoked with `token == weth`, the
    ///         contract burns the WETH and sends ETH to the relayer + treasury.
    ///         Setting to `address(0)` disables auto-unwrap (claims revert to
    ///         the plain ERC20 transfer path even for the same WETH address —
    ///         use this as a kill-switch if the WETH contract misbehaves).
    address public weth;

    /// @dev Reserved storage for future upgrades. Decrement when new state added.
    ///      Reduced from 50 → 49 when `weth` was added in the auto-unwrap
    ///      upgrade. Subsequent upgrades MUST keep adding from the top of
    ///      __gap (slot index 0) to preserve the layout of existing proxies.
    uint256[49] private __gap;

    // ─── Events ─────────────────────────────────────────────────
    event FeeDeposited(address indexed relayer, address indexed token, uint256 amount);
    event FeeClaimed(address indexed relayer, address indexed token, uint256 amount, uint256 platformFee);
    /// @notice Platform's `dexPlatformFeeBps` cut on a `settleWithDex` market order.
    event PlatformFeeFromDex(address indexed token, uint256 amount);
    /// @notice Positive DEX slippage (returned more than minOut) on `settleWithDex`.
    event PlatformSurplusFromDex(address indexed token, uint256 amount);
    /// @notice Platform's `platformFeeBps` cut skimmed when a relayer calls `claim()`.
    ///         Funds go straight to treasury (not via `platformRevenue` accumulator).
    event PlatformFeeFromRelayerClaim(address indexed token, uint256 amount, address indexed relayer);
    event PlatformRevenueWithdrawn(address indexed token, uint256 amount, address indexed to);
    event FeeChangeScheduled(uint256 currentBps, uint256 newBps, uint256 effectiveTime);
    event FeeChangeCancelled(uint256 cancelledBps);
    event PlatformFeeUpdated(uint256 oldBps, uint256 newBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event DepositorUpdated(address indexed depositor, bool authorized);
    event WethUpdated(address oldWeth, address newWeth);
    /// @notice Fired in addition to `FeeClaimed` when a claim was paid out
    ///         as native ETH via the WETH auto-unwrap path. The platform
    ///         fee portion is sent to `treasury` as ETH as well.
    event FeeClaimedAsEth(address indexed relayer, uint256 amount, uint256 platformFee);

    // ─── Errors ─────────────────────────────────────────────────
    error ZeroAddress();
    error FeeTooHigh();
    error NotAuthorized();
    error NothingToClaim();
    error RenounceOwnershipDisabled();
    error InsufficientTokenBalance();
    error NoFeeChangePending();
    error FeeChangeNotReady();
    /// @notice Native-ETH transfer to relayer or treasury failed (gas
    ///         starvation, target contract revert, etc.).
    error EthTransferFailed();
    /// @notice Stray ETH sent to the vault outside the WETH-unwrap path.
    error OnlyWethRefund();
    /// @notice `claimAsEth` invoked while `weth` slot is the zero address.
    error WethNotConfigured();
    /// @notice `claimAsEth` invoked with a token other than the configured WETH.
    error WrongClaimToken();
    /// @notice `setWeth` invoked with a non-zero address that has no code.
    error NotAContract();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address _treasury, uint256 _platformFeeBps) external initializer {
        if (initialOwner == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_platformFeeBps > MAX_PLATFORM_FEE) revert FeeTooHigh();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        treasury = _treasury;
        platformFeeBps = _platformFeeBps;
    }

    function renounceOwnership() public pure override(OwnableUpgradeable) {
        revert RenounceOwnershipDisabled();
    }

    // ─── Deposit (called by PrivateSettlement) ──────────────────

    /// @notice Credit fee to a relayer's balance.
    /// @dev Only authorized depositors can call this. Caller must have already
    ///      transferred tokens to this contract. Verifies that the vault's actual
    ///      token balance covers total tracked liabilities after the new deposit.
    ///
    ///      INVARIANT — no fee-on-transfer / rebasing fee tokens. This credits the
    ///      *requested* `amount` and then calls `_assertBalanceBacked`, which
    ///      requires `balanceOf(this) >= totalTracked + platformRevenue`. If a
    ///      fee-on-transfer token shaved the transfer, the actual balance falls
    ///      short of the credited total and the call reverts with
    ///      `InsufficientTokenBalance` — so under-funded (fee-on-transfer/rebasing)
    ///      deposits are rejected rather than silently over-crediting the relayer.
    ///      Fee tokens are expected to be standard ERC20s (e.g. TON).
    function deposit(address relayer, address token, uint256 amount) external nonReentrant {
        if (!authorizedDepositors[msg.sender]) revert NotAuthorized();
        if (relayer == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        balances[relayer][token] += amount;
        totalTracked[token] += amount;
        _assertBalanceBacked(token);

        emit FeeDeposited(relayer, token, amount);
    }

    /// @notice Credit the platform's cut of a `settleWithDex` sellAmount
    ///         (the configured `dexPlatformFeeBps`). Caller must have
    ///         already transferred `amount` of `token` to this contract.
    function accrueDexFee(address token, uint256 amount) external nonReentrant {
        _accruePlatformRevenue(token, amount);
        if (amount > 0) emit PlatformFeeFromDex(token, amount);
    }

    /// @notice Credit positive DEX slippage (returned more than minOut) on a
    ///         `settleWithDex` trade. Caller must have already transferred
    ///         `amount` of `token` to this contract.
    function accrueDexSurplus(address token, uint256 amount) external nonReentrant {
        _accruePlatformRevenue(token, amount);
        if (amount > 0) emit PlatformSurplusFromDex(token, amount);
    }

    /// @dev Shared body for the platform-revenue accrual paths: enforces
    ///      the depositor allowlist + balance-backed invariant, and
    ///      short-circuits zero-amount calls. Public wrappers must call
    ///      this BEFORE emitting their per-source event.
    function _accruePlatformRevenue(address token, uint256 amount) internal {
        if (!authorizedDepositors[msg.sender]) revert NotAuthorized();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        platformRevenue[token] += amount;
        _assertBalanceBacked(token);
    }

    /// @dev Catches deposit paths that credit an accounting bucket without
    ///      first transferring the underlying tokens.
    function _assertBalanceBacked(address token) internal view {
        if (IERC20(token).balanceOf(address(this)) < totalTracked[token] + platformRevenue[token]) {
            revert InsufficientTokenBalance();
        }
    }

    /// @notice Pull accumulated platform revenue for a specific token to the
    ///         treasury address. Only the treasury (or owner, which typically
    ///         is the same party) can call.
    function withdrawPlatformRevenue(address token) external nonReentrant {
        if (msg.sender != treasury && msg.sender != owner()) revert NotAuthorized();
        if (token == address(0)) revert ZeroAddress();
        uint256 amount = platformRevenue[token];
        if (amount == 0) revert NothingToClaim();

        platformRevenue[token] = 0;
        IERC20(token).safeTransfer(treasury, amount);

        emit PlatformRevenueWithdrawn(token, amount, treasury);
    }

    // ─── Claim (called by relayers) ─────────────────────────────

    /// @notice Withdraw accumulated fees for a specific token. Platform fee is deducted.
    ///         Pays out as the underlying ERC20. Smart-contract relayers
    ///         that cannot receive native ETH (no `receive()` / `fallback`)
    ///         MUST use this entry point — `claimAsEth` would revert their
    ///         payout on the ETH transfer.
    function claim(address token) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 balance = balances[msg.sender][token];
        if (balance == 0) revert NothingToClaim();

        balances[msg.sender][token] = 0;
        totalTracked[token] -= balance;

        uint256 platformFee = (balance * platformFeeBps) / 10000;
        uint256 relayerAmount = balance - platformFee;

        if (platformFee > 0) {
            IERC20(token).safeTransfer(treasury, platformFee);
            emit PlatformFeeFromRelayerClaim(token, platformFee, msg.sender);
        }
        if (relayerAmount > 0) {
            IERC20(token).safeTransfer(msg.sender, relayerAmount);
        }

        emit FeeClaimed(msg.sender, token, relayerAmount, platformFee);
    }

    /// @notice Opt-in WETH→ETH variant of `claim`. Unwraps the relayer's
    ///         full WETH balance via `IWETH9.withdraw` and pays both the
    ///         relayer and the treasury in native ETH. Only callable when
    ///         `weth` has been configured by the owner.
    /// @dev    Kept as a separate entry point (rather than auto-unwrapping
    ///         inside `claim`) so smart-contract relayers without a
    ///         payable receive can continue to claim ERC20 WETH. Reverts
    ///         with `WrongClaimToken` if `token != weth`, so a front-end
    ///         that hard-codes this selector for the WETH case can't
    ///         accidentally drain a non-WETH token through here.
    function claimAsEth(address token) external nonReentrant {
        address _weth = weth;
        if (_weth == address(0)) revert WethNotConfigured();
        if (token != _weth) revert WrongClaimToken();

        uint256 balance = balances[msg.sender][token];
        if (balance == 0) revert NothingToClaim();

        balances[msg.sender][token] = 0;
        totalTracked[token] -= balance;

        uint256 platformFee = (balance * platformFeeBps) / 10000;
        uint256 relayerAmount = balance - platformFee;

        // Unwrap once for the full balance, then split as ETH. Doing the
        // unwrap up-front keeps `totalTracked` and the on-chain WETH
        // supply consistent across the two recipient transfers — a
        // partial unwrap would leave the contract holding a sliver of
        // WETH that no relayer balance maps to.
        IWETH9(_weth).withdraw(balance);

        if (platformFee > 0) {
            _sendEth(treasury, platformFee);
            emit PlatformFeeFromRelayerClaim(token, platformFee, msg.sender);
        }
        if (relayerAmount > 0) {
            _sendEth(msg.sender, relayerAmount);
        }
        emit FeeClaimed(msg.sender, token, relayerAmount, platformFee);
        emit FeeClaimedAsEth(msg.sender, relayerAmount, platformFee);
    }

    /// @dev Internal helper for the ETH path. Surfaces a typed error
    ///      instead of bubbling the bare `call` failure so the front-end
    ///      revert reason maps to a known case. The two callers of this
    ///      helper inside `claimAsEth` pass either `treasury` (owner-
    ///      set, address(0) blocked) or `msg.sender` (the relayer
    ///      claiming their own balance) — neither is "arbitrary" in
    ///      slither's sense. Suppression mirrors RelayerRegistry._pushBond.
    // slither-disable-next-line arbitrary-send-eth
    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @notice Receive native ETH ONLY from the configured WETH contract
    ///         during a `claim()` unwrap. Rejecting other senders prevents
    ///         random EOAs from parking ETH on the vault, where it would
    ///         not be tracked by `balances` or `platformRevenue` and would
    ///         eventually be stranded.
    receive() external payable {
        if (msg.sender != weth) revert OnlyWethRefund();
    }

    // ─── Admin ──────────────────────────────────────────────────

    /// @notice Add or remove an authorized depositor (typically PrivateSettlement).
    function setAuthorizedDepositor(address depositor, bool authorized) external onlyOwner {
        if (depositor == address(0)) revert ZeroAddress();
        authorizedDepositors[depositor] = authorized;
        emit DepositorUpdated(depositor, authorized);
    }

    /// @notice Configure (or disable) the WETH auto-unwrap path.
    ///         Pass `address(0)` to disable — claim() then transfers WETH
    ///         as a plain ERC20 instead of unwrapping to native ETH.
    function setWeth(address _weth) external onlyOwner {
        // Non-zero targets must have contract code — an EOA or
        // unsuspecting address would DoS every `claimAsEth` call when
        // the unwrap selector reverts. `address(0)` is allowed as the
        // explicit disable.
        if (_weth != address(0) && _weth.code.length == 0) revert NotAContract();
        address prev = weth;
        weth = _weth;
        emit WethUpdated(prev, _weth);
    }

    /// @notice Schedule a platform fee change. Takes effect after FEE_CHANGE_DELAY.
    ///         Relayers can observe the pending change on-chain and claim at the
    ///         current rate before the new fee activates.
    function scheduleFeeChange(uint256 _bps) external onlyOwner {
        if (_bps > MAX_PLATFORM_FEE) revert FeeTooHigh();
        pendingFeeBps = _bps;
        pendingFeeEffectiveTime = block.timestamp + FEE_CHANGE_DELAY;
        emit FeeChangeScheduled(platformFeeBps, _bps, pendingFeeEffectiveTime);
    }

    /// @notice Apply the pending fee change after the timelock has elapsed.
    function applyFeeChange() external onlyOwner {
        if (pendingFeeEffectiveTime == 0) revert NoFeeChangePending();
        if (block.timestamp < pendingFeeEffectiveTime) revert FeeChangeNotReady();
        emit PlatformFeeUpdated(platformFeeBps, pendingFeeBps);
        platformFeeBps = pendingFeeBps;
        pendingFeeBps = 0;
        pendingFeeEffectiveTime = 0;
    }

    /// @notice Cancel a pending fee change.
    function cancelFeeChange() external onlyOwner {
        if (pendingFeeEffectiveTime == 0) revert NoFeeChangePending();
        emit FeeChangeCancelled(pendingFeeBps);
        pendingFeeBps = 0;
        pendingFeeEffectiveTime = 0;
    }

    /// @notice Update the treasury address that receives platform fees.
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }
}
