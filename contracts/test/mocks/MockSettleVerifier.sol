// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISettleVerifier} from "../../src/zk/ISettleVerifier.sol";

contract MockSettleVerifier is ISettleVerifier {
    bool public shouldPass = true;
    bool public enforceRelayer;
    address public expectedMakerRelayer;
    address public expectedTakerRelayer;

    function setShouldPass(bool _pass) external { shouldPass = _pass; }
    function setEnforceRelayer(bool _enforce, address _makerRelayer, address _takerRelayer) external {
        enforceRelayer = _enforce;
        expectedMakerRelayer = _makerRelayer;
        expectedTakerRelayer = _takerRelayer;
    }

    function verifyProof(uint[2] calldata, uint[2][2] calldata, uint[2] calldata, uint[18] calldata _pubSignals) external view returns (bool) {
        if (!shouldPass) return false;
        if (enforceRelayer) {
            // pubSignals[16] = makerRelayer, pubSignals[17] = takerRelayer
            // In real Groth16, the proof is cryptographically bound to specific relayer addresses.
            if (_pubSignals[16] != uint256(uint160(expectedMakerRelayer))) return false;
            if (_pubSignals[17] != uint256(uint160(expectedTakerRelayer))) return false;
        }
        return true;
    }
}
