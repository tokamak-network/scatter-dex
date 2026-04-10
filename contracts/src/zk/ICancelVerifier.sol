// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Verifier for `circuits/cancel.circom` — escrow rotation cancel.
///
/// Public signals (in order, matching cancel.circom's `component main { public [...] }`):
///   [0] commitmentRoot     uint256 — Merkle root for commitment membership
///   [1] oldNullifier       bytes32 — escrow nullifier to burn
///   [2] oldNonceNullifier  bytes32 — nonce nullifier to burn
///   [3] newCommitment      bytes32 — rotated commitment (same balance, new salt)
///   [4] submitter           uint160 — msg.sender binding (user, not relayer)
interface ICancelVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[5] calldata _pubSignals
    ) external view returns (bool);
}
