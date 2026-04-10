// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Interface for batched Groth16 verification of two authorize.circom proofs.
///         Uses random linear combination (Fiat-Shamir) to reduce from 8 pairings
///         to 5, saving ~24% gas on verification.
interface IBatchAuthorizeVerifier {
    function verifyBatchProof(
        uint[2] calldata _pA1, uint[2][2] calldata _pB1, uint[2] calldata _pC1, uint[14] calldata _pubSignals1,
        uint[2] calldata _pA2, uint[2][2] calldata _pB2, uint[2] calldata _pC2, uint[14] calldata _pubSignals2
    ) external view returns (bool);
}
