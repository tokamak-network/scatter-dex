// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

contract IdentityGate {
    IIdentityRegistry public immutable registry;

    constructor(address _registry) {
        registry = IIdentityRegistry(_registry);
    }

    function isVerified(address user) external view returns (bool) {
        return registry.isVerified(user);
    }

    modifier onlyVerified(address user) {
        require(registry.isVerified(user), "IdentityGate: not verified");
        _;
    }
}
