// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBatchAuthorizeVerifier} from "../../src/zk/IBatchAuthorizeVerifier.sol";

/// @notice Mock for BatchAuthorizeVerifier. Default: returns true.
///         Tests can flip via `setShouldPass(false)`.
contract MockBatchAuthorizeVerifier is IBatchAuthorizeVerifier {
    bool public shouldPass = true;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    function verifyBatchProof(
        uint[2] calldata, uint[2][2] calldata, uint[2] calldata, uint[15] calldata,
        uint[2] calldata, uint[2][2] calldata, uint[2] calldata, uint[15] calldata
    ) external view returns (bool) {
        return shouldPass;
    }
}
