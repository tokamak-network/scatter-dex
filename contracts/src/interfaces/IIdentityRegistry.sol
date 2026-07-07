// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface for zk-X509 IdentityRegistry.
/// @dev Matches the public API of IdentityRegistry.sol from the zk-X509 project.
interface IIdentityRegistry {
    /// @notice Check if a wallet address is currently verified (not expired).
    function isVerified(address user) external view returns (bool);

    /// @notice Certificate expiry timestamp for a verified address (0 = unverified).
    function verifiedUntil(address user) external view returns (uint64);

    /// @notice Whether the registry is paused (emergency stop).
    function paused() external view returns (bool);
}
