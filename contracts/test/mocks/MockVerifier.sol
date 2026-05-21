// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVerifier} from "../../src/zk/IVerifier.sol";

/// @dev Mock verifier that always returns true. For unit testing only.
contract MockVerifier is IVerifier {
    bool public shouldPass = true;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[7] calldata)
        external
        view
        returns (bool)
    {
        return shouldPass;
    }
}
