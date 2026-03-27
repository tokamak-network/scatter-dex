// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ScatterSettlement} from "./ScatterSettlement.sol";

/// @notice EIP-7702 delegation target for batch operations.
/// @dev Stateless — no constructor storage. Designed to be delegated to by an EOA
///      via EIP-7702 (tx type 4). When delegated, `address(this)` is the EOA,
///      so approve/deposit execute in the EOA's context.
///
///      Also works as a regular helper contract (non-delegated) where the user
///      calls it directly and it acts on their behalf via transferFrom.
contract VaultSkills {
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    error ZeroAmount();
    error ArrayEmpty();

    /// @notice Approve + deposit a single token into ScatterSettlement in one call.
    /// @dev In EIP-7702 delegated mode: address(this) = EOA, so approve is from EOA.
    ///      In non-delegated mode: caller must have already approved this contract,
    ///      and this contract approves settlement then deposits on behalf of caller.
    function approveAndDeposit(address settlement, address token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        IERC20(token).approve(settlement, amount);
        ScatterSettlement(settlement).deposit(token, amount);
    }

    /// @notice Batch approve + deposit multiple tokens.
    function approveAndDepositMultiple(address settlement, TokenAmount[] calldata tokens) external {
        if (tokens.length == 0) revert ArrayEmpty();

        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            IERC20(tokens[i].token).approve(settlement, tokens[i].amount);
            ScatterSettlement(settlement).deposit(tokens[i].token, tokens[i].amount);
        }
    }

    /// @notice Batch withdraw multiple tokens from ScatterSettlement.
    function withdrawMultiple(address settlement, TokenAmount[] calldata tokens) external {
        if (tokens.length == 0) revert ArrayEmpty();

        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i].amount == 0) revert ZeroAmount();
            ScatterSettlement(settlement).withdraw(tokens[i].token, tokens[i].amount);
        }
    }
}
