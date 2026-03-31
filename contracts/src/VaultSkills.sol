// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ScatterSettlement} from "./ScatterSettlement.sol";
import {IWETH} from "./interfaces/IWETH.sol";

/// @notice EIP-7702 delegation target for batch operations.
/// @dev Stateless — no constructor, no storage slots. Designed to be delegated to
///      by an EOA via EIP-7702 (tx type 4). When delegated, `address(this)` is the
///      EOA, so approve/deposit execute in the EOA's context.
///      Traditional ReentrancyGuard is intentionally omitted because it uses storage
///      slots which would mutate the delegator's storage under EIP-7702 delegation.
///      Only ScatterSettlement itself is protected by its own nonReentrant modifier;
///      VaultSkills functions may still be re-entered via token hooks, and callers
///      must not rely on VaultSkills being non-reentrant.
contract VaultSkills {
    using SafeERC20 for IERC20;

    struct TokenAmount {
        address token;
        uint256 amount;
    }

    error ZeroAmount();
    error ArrayEmpty();
    error ZeroAddress();
    error ETHTransferFailed();

    /// @notice Approve + deposit a single token into ScatterSettlement in one call.
    function approveAndDeposit(address settlement, address token, uint256 amount) external {
        if (settlement == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _safeApproveAndDeposit(settlement, token, amount);
    }

    /// @notice Batch approve + deposit multiple tokens.
    function approveAndDepositMultiple(address settlement, TokenAmount[] calldata tokens) external {
        if (settlement == address(0)) revert ZeroAddress();
        if (tokens.length == 0) revert ArrayEmpty();

        uint256 len = tokens.length;
        for (uint256 i; i < len; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            _safeApproveAndDeposit(settlement, tokens[i].token, tokens[i].amount);
        }
    }

    /// @notice Wrap ETH → WETH, then approve + deposit into Settlement.
    /// @dev User sends ETH via msg.value. Internally wraps to WETH and deposits.
    function wrapAndDeposit(address settlement, address weth) external payable {
        if (settlement == address(0) || weth == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        IWETH(weth).deposit{value: msg.value}();
        _safeApproveAndDeposit(settlement, weth, msg.value);
    }

    /// @notice Batch withdraw multiple tokens from ScatterSettlement.
    function withdrawMultiple(address settlement, TokenAmount[] calldata tokens) external {
        if (settlement == address(0)) revert ZeroAddress();
        if (tokens.length == 0) revert ArrayEmpty();

        uint256 len = tokens.length;
        for (uint256 i; i < len; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            ScatterSettlement(settlement).withdraw(tokens[i].token, tokens[i].amount);
        }
    }

    /// @notice Withdraw WETH from Settlement, unwrap to ETH, send to caller.
    function withdrawAndUnwrap(address settlement, address weth, uint256 amount) external {
        if (settlement == address(0) || weth == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        ScatterSettlement(settlement).withdraw(weth, amount);
        IWETH(weth).withdraw(amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert ETHTransferFailed();
    }

    /// @dev Needed to receive ETH from WETH.withdraw()
    receive() external payable {}

    /// @dev Approve exact amount, deposit, then revoke any remaining allowance.
    ///      Uses SafeERC20.forceApprove for non-standard tokens (USDT etc).
    function _safeApproveAndDeposit(address settlement, address token, uint256 amount) internal {
        IERC20 token_ = IERC20(token);
        token_.forceApprove(settlement, amount);
        ScatterSettlement(settlement).deposit(token, amount);
        // Revoke leftover allowance to prevent token drain
        uint256 remaining = token_.allowance(address(this), settlement);
        if (remaining > 0) {
            token_.forceApprove(settlement, 0);
        }
    }
}
