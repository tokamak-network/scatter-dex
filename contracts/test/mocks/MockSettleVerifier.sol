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
            // pubSignals[16] is msg.sender (set by PrivateSettlement.settlePrivate).
            // In real Groth16, the proof is cryptographically bound to a specific relayer.
            // If a different address submits, msg.sender differs → pubSignals[16] mismatches
            // the value inside the proof → verification fails. We simulate this by checking
            // pubSignals[16] against a stored expected relayer address.
            return _pubSignals[16] == uint256(uint160(expectedRelayer));
        }
        return true;
    }
}
