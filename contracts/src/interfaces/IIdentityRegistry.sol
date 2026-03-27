// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IIdentityRegistry {
    function isVerified(address user) external view returns (bool);
}
