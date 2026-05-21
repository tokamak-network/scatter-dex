// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICancelVerifier} from "../../src/zk/ICancelVerifier.sol";

contract MockCancelVerifier is ICancelVerifier {
    bool public shouldPass = true;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata)
        external
        view
        returns (bool)
    {
        return shouldPass;
    }
}
