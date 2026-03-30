// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @dev Reusable mock identity registry for testing. Supports both User CA and Relayer CA scenarios.
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(address => bool) public verified;

    function setVerified(address user, bool status) external {
        verified[user] = status;
    }

    function isVerified(address user) external view override returns (bool) {
        return verified[user];
    }

    function verifiedUntil(address) external pure override returns (uint64) {
        return type(uint64).max;
    }

    function paused() external pure override returns (bool) {
        return false;
    }
}
