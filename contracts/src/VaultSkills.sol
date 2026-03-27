// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ScatterSettlement} from "./ScatterSettlement.sol";

/// @notice EIP-7702 delegation target for batch operations.
/// @dev Stateless — no constructor storage. Designed to be delegated to by an EOA
///      via EIP-7702 (tx type 4). When delegated, `address(this)` is the EOA,
///      so approve/deposit execute in the EOA's context.
contract VaultSkills {
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    error ZeroAmount();
    error ArrayEmpty();
    error ZeroAddress();

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

        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            _safeApproveAndDeposit(settlement, tokens[i].token, tokens[i].amount);
        }
    }

    /// @notice Batch withdraw multiple tokens from ScatterSettlement.
    function withdrawMultiple(address settlement, TokenAmount[] calldata tokens) external {
        if (settlement == address(0)) revert ZeroAddress();
        if (tokens.length == 0) revert ArrayEmpty();

        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            ScatterSettlement(settlement).withdraw(tokens[i].token, tokens[i].amount);
        }
    }

    /// @dev Approve exact amount, deposit, then revoke any remaining allowance.
    function _safeApproveAndDeposit(address settlement, address token, uint256 amount) internal {
        IERC20(token).approve(settlement, amount);
        ScatterSettlement(settlement).deposit(token, amount);
        // Revoke leftover allowance if deposit consumed less than approved
        uint256 remaining = IERC20(token).allowance(address(this), settlement);
        if (remaining > 0) {
            IERC20(token).approve(settlement, 0);
        }
    }
}
