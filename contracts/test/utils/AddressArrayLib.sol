// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Tiny shared helpers for asserting over `address[]` returned by getters
///      such as `getWhitelistedTokens()`. Keeps the membership loop in one
///      place instead of copy-pasting a `_contains` helper into each suite.
library AddressArrayLib {
    /// @notice True if `target` appears anywhere in `arr`.
    function contains(address[] memory arr, address target) internal pure returns (bool) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == target) return true;
        }
        return false;
    }
}
