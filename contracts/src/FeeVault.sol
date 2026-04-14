// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FeeVault
/// @notice Accumulates settlement fees for relayers and deducts a platform fee on withdrawal.
///         PrivateSettlement deposits fees here during settle/scatterDirect.
///         Relayers claim their earned fees; platform fee (in bps) is deducted and sent to treasury.
contract FeeVault is Ownable2Step, ReentrancyGuard {
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

    // ─── Events ─────────────────────────────────────────────────
    event FeeDeposited(address indexed relayer, address indexed token, uint256 amount);
    event FeeClaimed(address indexed relayer, address indexed token, uint256 amount, uint256 platformFee);
    event PlatformRevenueDeposited(address indexed token, uint256 amount, bytes32 indexed source);
    event PlatformRevenueWithdrawn(address indexed token, uint256 amount, address indexed to);
    event FeeChangeScheduled(uint256 currentBps, uint256 newBps, uint256 effectiveTime);
    event FeeChangeCancelled(uint256 cancelledBps);
    event PlatformFeeUpdated(uint256 oldBps, uint256 newBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event DepositorUpdated(address indexed depositor, bool authorized);

    // ─── Errors ─────────────────────────────────────────────────
    error ZeroAddress();
    error FeeTooHigh();
    error NotAuthorized();
    error NothingToClaim();
    error RenounceOwnershipDisabled();
    error InsufficientTokenBalance();
    error NoFeeChangePending();
    error FeeChangeNotReady();

    constructor(address _treasury, uint256 _platformFeeBps) Ownable(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_platformFeeBps > MAX_PLATFORM_FEE) revert FeeTooHigh();
        treasury = _treasury;
        platformFeeBps = _platformFeeBps;
    }

    function renounceOwnership() public pure override { revert RenounceOwnershipDisabled(); }

    // ─── Deposit (called by PrivateSettlement) ──────────────────

    /// @notice Credit fee to a relayer's balance.
    /// @dev Only authorized depositors can call this. Caller must have already
    ///      transferred tokens to this contract. Verifies that the vault's actual
    ///      token balance covers total tracked liabilities after the new deposit.
    function deposit(address relayer, address token, uint256 amount) external nonReentrant {
        if (!authorizedDepositors[msg.sender]) revert NotAuthorized();
        if (relayer == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        balances[relayer][token] += amount;
        totalTracked[token] += amount;

        // Verify vault actually holds enough tokens to cover all tracked balances.
        // This catches cases where deposit() is called without prior token transfer.
        if (IERC20(token).balanceOf(address(this)) < totalTracked[token] + platformRevenue[token]) {
            revert InsufficientTokenBalance();
        }

        emit FeeDeposited(relayer, token, amount);
    }

    /// @notice Credit platform revenue from a settleWithDex path (market order
    ///         platform fee or positive-slippage surplus). Caller must have
    ///         already transferred `amount` of `token` to this contract.
    /// @param source Semantic tag for analytics (e.g. keccak256("market-surplus"),
    ///        keccak256("market-platform-fee")). Not interpreted on-chain.
    function depositPlatformRevenue(address token, uint256 amount, bytes32 source) external nonReentrant {
        if (!authorizedDepositors[msg.sender]) revert NotAuthorized();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        platformRevenue[token] += amount;

        if (IERC20(token).balanceOf(address(this)) < totalTracked[token] + platformRevenue[token]) {
            revert InsufficientTokenBalance();
        }

        emit PlatformRevenueDeposited(token, amount, source);
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
        }
        if (relayerAmount > 0) {
            IERC20(token).safeTransfer(msg.sender, relayerAmount);
        }

        emit FeeClaimed(msg.sender, token, relayerAmount, platformFee);
    }

    // ─── Admin ──────────────────────────────────────────────────

    /// @notice Add or remove an authorized depositor (typically PrivateSettlement).
    function setAuthorizedDepositor(address depositor, bool authorized) external onlyOwner {
        if (depositor == address(0)) revert ZeroAddress();
        authorizedDepositors[depositor] = authorized;
        emit DepositorUpdated(depositor, authorized);
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
