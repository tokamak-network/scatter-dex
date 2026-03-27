// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ScatterSettlement} from "./ScatterSettlement.sol";

/// @notice EIP-7702 delegation target for batch operations.
/// @dev Designed to be delegated to by an EOA via EIP-7702 (tx type 4).
///      When delegated, `address(this)` is the EOA,
///      so approve/deposit execute in the EOA's context.
contract VaultSkills is ReentrancyGuard {
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    error ZeroAmount();
    error ArrayEmpty();
    error ZeroAddress();

    /// @notice Approve + deposit a single token into ScatterSettlement in one call.
    function approveAndDeposit(address settlement, address token, uint256 amount) external nonReentrant {
        if (settlement == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _safeApproveAndDeposit(settlement, token, amount);
    }

    /// @notice Batch approve + deposit multiple tokens.
    function approveAndDepositMultiple(address settlement, TokenAmount[] calldata tokens) external nonReentrant {
        if (settlement == address(0)) revert ZeroAddress();
        if (tokens.length == 0) revert ArrayEmpty();

        uint256 len = tokens.length;
        for (uint256 i; i < len; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            _safeApproveAndDeposit(settlement, tokens[i].token, tokens[i].amount);
        }
    }

    /// @notice Batch withdraw multiple tokens from ScatterSettlement.
    function withdrawMultiple(address settlement, TokenAmount[] calldata tokens) external nonReentrant {
        if (settlement == address(0)) revert ZeroAddress();
        if (tokens.length == 0) revert ArrayEmpty();

        uint256 len = tokens.length;
        for (uint256 i; i < len; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            ScatterSettlement(settlement).withdraw(tokens[i].token, tokens[i].amount);
        }
    }

    /// @dev Approve exact amount, deposit, then revoke any remaining allowance.
    ///      Resets allowance to 0 before approve to support tokens like USDT
    ///      that require zero allowance before setting a new non-zero value.
    function _safeApproveAndDeposit(address settlement, address token, uint256 amount) internal {
        IERC20 token_ = IERC20(token);
        if (token_.allowance(address(this), settlement) != 0) {
            token_.approve(settlement, 0);
        }
        token_.approve(settlement, amount);
        ScatterSettlement(settlement).deposit(token, amount);
        token_.approve(settlement, 0);
    }
}
