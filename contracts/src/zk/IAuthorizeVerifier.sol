// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Verifier for `circuits/authorize.circom` — the Half-proof primitive
///         that lets each user (maker / taker) prove their own side of a trade
///         independently in their browser. The relayer matches two such proofs
///         and submits them via `PrivateSettlement.settleAuth(...)` for atomic
///         on-chain settlement.
///
/// Public signals (in order, matching `SettleVerifyLib.packAuthSignals`;
/// `pubKeyBind` is a circuit *output* so circom sorts it before the declared
/// public inputs):
///   [0]  pubKeyBind       bytes32 — Poseidon(pubKeyAx, pubKeyAy, nullifier); compliance binding (ADR-002)
///   [1]  commitmentRoot   uint256 — Merkle root used for the membership proof
///   [2]  nullifier        bytes32 — escrow nullifier (Poseidon(0, secret, salt))
///   [3]  nonceNullifier   bytes32 — nonce nullifier (Poseidon(1, secret, nonce))
///   [4]  newCommitment    bytes32 — residual UTXO commitment (0 if fully spent)
///   [5]  sellToken        uint160 packed into uint256 — token the user is selling
///   [6]  buyToken         uint160 packed into uint256 — token the user is receiving
///   [7]  sellAmount       uint128 — amount being sold (range-checked to ≤ 2^126 in-circuit)
///   [8]  buyAmount        uint128 — minimum amount the user requires (≤ 2^126 in-circuit)
///   [9]  maxFee           uint16  — maximum fee in basis points the user authorises
///   [10] expiry           uint64  — unix seconds; settleAuth must verify against block.timestamp
///   [11] claimsRoot       bytes32 — Merkle root of this user's claims tree
///   [12] totalLocked      uint128 — sum of this user's claim amounts (must equal sum in-circuit; circuit Num2Bits(128))
///   [13] relayer          uint160 packed into uint256 — relayer bound in proof
///   [14] orderHash        bytes32 — Poseidon hash over the EdDSA-signed order parameters
///
/// The authorize circuit ships in tiers keyed by max claims per side —
/// tier 16 (`authorize.circom`, `claimsTreeDepth = 4`), tier 64
/// (`authorize_64.circom`, depth 6), tier 128 (`authorize_128.circom`,
/// depth 7) — all sharing `commitTreeDepth = 20` and this same 15-signal
/// ABI (the claims set is hashed into `claimsRoot`, so the tier never
/// reaches the verifier interface). Each tier has its own Groth16
/// verifier deployment, registered via
/// `PrivateSettlement.setAuthorizeVerifier(tier, addr)`; regenerating a
/// circuit means re-pointing that tier's entry.
///
/// See `docs/design/circuit-split/design.md` for the architectural rationale
/// and the bit-width audit (`docs/circuit-split/bit-width-audit.md` §5,
/// removed in the docs reorg — recover from git history) for why `sellAmount`
/// / `buyAmount` are constrained to ≤ 2^126 even though the on-chain types
/// are `uint128`.
interface IAuthorizeVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[15] calldata _pubSignals
    ) external view returns (bool);
}
