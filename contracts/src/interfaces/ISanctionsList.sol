// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Interface for sanctions/blocklist checking.
///         Compatible with Chainalysis SanctionsList oracle (0x40C57923...)
///         and the project's own SanctionsList.sol.
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}
