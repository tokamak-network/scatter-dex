// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISettleVerifier} from "../../src/zk/ISettleVerifier.sol";

contract MockSettleVerifier is ISettleVerifier {
    bool public shouldPass = true;
    function setShouldPass(bool _pass) external { shouldPass = _pass; }
    function verifyProof(uint[2] calldata, uint[2][2] calldata, uint[2] calldata, uint[16] calldata) external view returns (bool) {
        return shouldPass;
    }
}
