// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Verifier for deposit.circom — proves the on-chain
///         (commitment, token, amount) tuple matches the preimage of the
///         user's escrow commitment, preventing pool-drain attacks where a
///         user submits a commitment claiming a balance larger than the
///         deposit they actually made.
///
/// Public signals (in order):
///   [0] commitment
///   [1] token        (uint160 packed into uint256)
///   [2] amount
interface IDepositVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[3] calldata _pubSignals
    ) external view returns (bool);
}
