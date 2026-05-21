// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDepositVerifier} from "../../src/zk/IDepositVerifier.sol";

/// @dev Mock deposit verifier. Default returns true; can be toggled to false
///      to simulate a rejected proof. For unit testing only.
contract MockDepositVerifier is IDepositVerifier {
    bool public shouldPass = true;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[3] calldata)
        external
        view
        returns (bool)
    {
        return shouldPass;
    }
}
