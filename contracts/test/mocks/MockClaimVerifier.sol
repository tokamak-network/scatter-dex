// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClaimVerifier} from "../../src/zk/IClaimVerifier.sol";

contract MockClaimVerifier is IClaimVerifier {
    bool public shouldPass = true;
    function setShouldPass(bool _pass) external { shouldPass = _pass; }
    function verifyProof(uint[2] calldata, uint[2][2] calldata, uint[2] calldata, uint[6] calldata) external view returns (bool) {
        return shouldPass;
    }
}
