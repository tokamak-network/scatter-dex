// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClaimVerifier} from "../../src/zk/IClaimVerifier.sol";

contract MockClaimVerifier is IClaimVerifier {
    bool public shouldPass = true;
    bool public enforceRecipient;
    address public expectedRecipient;

    function setShouldPass(bool _pass) external {
        shouldPass = _pass;
    }

    /// @notice Pin public-signal #4 (recipient) to a specific address.
    ///         Lets tests assert the caller bound the proof to the
    ///         correct destination — mirrors the real Groth16
    ///         verifier's cryptographic binding of recipient to the
    ///         leaf preimage.
    function setEnforceRecipient(bool _enforce, address _recipient) external {
        enforceRecipient = _enforce;
        expectedRecipient = _recipient;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[6] calldata _pubSignals
    ) external view returns (bool) {
        if (!shouldPass) return false;
        if (enforceRecipient) {
            // Public signals: [claimsRoot, nullifier, amount, token, recipient, releaseTime]
            if (_pubSignals[4] != uint256(uint160(expectedRecipient))) return false;
        }
        return true;
    }
}
