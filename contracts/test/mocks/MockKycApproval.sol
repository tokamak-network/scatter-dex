// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IKycApproval} from "../../src/interfaces/IKycApproval.sol";

/// @dev Reusable mock KYC-approval registry for exercising the RelayerRegistry AND gate.
///      Mirrors MockIdentityRegistry's setter/getter shape.
contract MockKycApproval is IKycApproval {
    mapping(address => bool) public approved;

    function setApproved(address wallet, bool status) external {
        approved[wallet] = status;
    }

    function isApproved(address wallet) external view override returns (bool) {
        return approved[wallet];
    }
}
