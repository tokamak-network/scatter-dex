// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Verifier for `circuits/authorize.circom` — the Half-proof primitive
///         that lets each user (maker / taker) prove their own side of a trade
///         independently in their browser. The relayer matches two such proofs
///         and submits them via `PrivateSettlement.settleAuth(...)` for atomic
///         on-chain settlement.
///
/// Public signals (in order, matching `authorize.circom`'s `component main {public [...]}`):
///   [0]  commitmentRoot   uint256 — Merkle root used for the membership proof
///   [1]  nullifier        bytes32 — escrow nullifier (Poseidon(0, secret, salt))
///   [2]  nonceNullifier   bytes32 — nonce nullifier (Poseidon(1, secret, nonce))
///   [3]  newCommitment    bytes32 — residual UTXO commitment (0 if fully spent)
///   [4]  sellToken        uint160 packed into uint256 — token the user is selling
///   [5]  buyToken         uint160 packed into uint256 — token the user is receiving
///   [6]  sellAmount       uint128 — amount being sold (range-checked to ≤ 2^126 in-circuit)
///   [7]  buyAmount        uint128 — minimum amount the user requires (≤ 2^126 in-circuit)
///   [8]  maxFee           uint16  — maximum fee in basis points the user authorises
///   [9]  expiry           uint64  — unix seconds; settleAuth must verify against block.timestamp
///   [10] claimsRoot       bytes32 — Merkle root of this user's claims tree
///   [11] totalLocked      uint96  — sum of this user's claim amounts (must equal sum in-circuit)
///   [12] relayer          uint160 packed into uint256 — relayer bound in proof
///   [13] orderHash        bytes32 — Poseidon hash over the EdDSA-signed order parameters
///
/// The current `circuits/authorize.circom` is built with the same parameters as
/// `settle.circom` (`commitTreeDepth = 20`, `maxClaimsPerSide = 16`,
/// `claimsTreeDepth = 4`). If those parameters change, the deployed
/// `AuthorizeVerifier` must be regenerated and re-pointed via
/// `PrivateSettlement.setAuthorizeVerifier(...)`.
///
/// See `docs/circuit-split/design.md` for the architectural rationale and
/// `docs/circuit-split/bit-width-audit.md` §5 for why `sellAmount` /
/// `buyAmount` are constrained to ≤ 2^126 even though the on-chain types are
/// `uint128`.
interface IAuthorizeVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[15] calldata _pubSignals
    ) external view returns (bool);
}
