// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @notice Wraps a zk-X509 IdentityRegistry for DEX access control.
/// @dev Pure read-only wrapper — no owner, no admin, no upgradability.
contract IdentityGate {
    IIdentityRegistry public immutable registry;

    error RegistryAddressZero();

    constructor(address _registry) {
        if (_registry == address(0)) revert RegistryAddressZero();
        registry = IIdentityRegistry(_registry);
    }

    /// @notice Check if user is verified and certificate not expired.
    function isVerified(address user) external view returns (bool) {
        return registry.isVerified(user);
    }

    /// @notice Get certificate expiry timestamp (0 = unverified).
    function verifiedUntil(address user) external view returns (uint64) {
        return registry.verifiedUntil(user);
    }
}
