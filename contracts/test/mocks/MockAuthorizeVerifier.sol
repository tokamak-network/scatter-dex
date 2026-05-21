// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAuthorizeVerifier} from "../../src/zk/IAuthorizeVerifier.sol";

/// @notice Mock for `circuits/authorize.circom`'s Groth16 verifier.
///         Default behaviour: every call returns `true`. Tests can flip this
///         via `setShouldPass(false)` to exercise the `InvalidProof` revert
///         path. The optional relayer-pinning mode lets a test assert that
///         the proof was generated for a specific relayer (since the real
///         Groth16 verifier cryptographically binds
///         `relayer` as public signal #13 of the authorize circuit).
contract MockAuthorizeVerifier is IAuthorizeVerifier {
    bool public shouldPass = true;
    bool public enforceRelayer;
    address public expectedRelayer;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    function setEnforceRelayer(bool _enforce, address _relayer) external {
        enforceRelayer = _enforce;
        expectedRelayer = _relayer;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[15] calldata _pubSignals
    ) external view returns (bool) {
        if (!shouldPass) return false;
        if (enforceRelayer) {
            // Public signal #13 is `relayer` (uint160 packed into uint256).
            // [0]=pubKeyBind, [1..14]=public inputs
            if (_pubSignals[13] != uint256(uint160(expectedRelayer))) return false;
        }
        return true;
    }
}
