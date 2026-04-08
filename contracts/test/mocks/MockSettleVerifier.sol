// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISettleVerifier} from "../../src/zk/ISettleVerifier.sol";

contract MockSettleVerifier is ISettleVerifier {
    bool public shouldPass = true;
    bool public enforceRelayer;
    address public expectedRelayer;

    function setShouldPass(bool _pass) external { shouldPass = _pass; }
    function setEnforceRelayer(bool _enforce, address _relayer) external {
        enforceRelayer = _enforce;
        expectedRelayer = _relayer;
    }

    function verifyProof(uint[2] calldata, uint[2][2] calldata, uint[2] calldata, uint[17] calldata _pubSignals) external view returns (bool) {
        if (!shouldPass) return false;
        if (enforceRelayer) {
            // pubSignals[16] is the relayer address (msg.sender of settlePrivate).
            // In real Groth16, the proof is bound to a specific relayer address.
            // If a different address submits, the proof doesn't match → false.
            // We simulate this by storing the expected relayer and checking against it.
            return _pubSignals[16] == uint256(uint160(expectedRelayer));
        }
        return true;
    }
}
