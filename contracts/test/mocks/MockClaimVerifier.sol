// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IClaimVerifier} from "../../src/zk/IClaimVerifier.sol";

contract MockClaimVerifier is IClaimVerifier {
    bool public shouldPass = true;
    bool public enforceRecipient;
    address public expectedRecipient;

    function setShouldPass(bool _pass) external { shouldPass = _pass; }

    /// @notice Pin the public-signal `recipient` (signal #4 of the claim
    ///         circuit) to a specific address. Lets tests assert the
    ///         caller bound the proof to the correct destination —
    ///         critical for `claimToPool` where the recipient is
    ///         expected to be the pool's address.
    function setEnforceRecipient(bool _enforce, address _recipient) external {
        enforceRecipient = _enforce;
        expectedRecipient = _recipient;
    }

    function verifyProof(uint[2] calldata, uint[2][2] calldata, uint[2] calldata, uint[6] calldata _pubSignals)
        external view returns (bool)
    {
        if (!shouldPass) return false;
        if (enforceRecipient) {
            // Public signals: [claimsRoot, nullifier, amount, token, recipient, releaseTime]
            if (_pubSignals[4] != uint256(uint160(expectedRecipient))) return false;
        }
        return true;
    }
}
