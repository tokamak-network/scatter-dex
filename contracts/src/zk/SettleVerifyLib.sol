// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {CommitmentPool} from "./CommitmentPool.sol";

/// @title SettleVerifyLib
/// @notice Pure/view helpers extracted from PrivateSettlement to keep the
///         main contract under the EIP-170 24,576-byte limit. Public library
///         functions are deployed separately and linked via DELEGATECALL.
library SettleVerifyLib {
    // ─── Errors ──────────────────────────────────────────────────
    error TokenSidesMismatch();
    error PriceMismatch();
    error ClaimsCapExceeded();
    error FeeExceedsMax();
    error OrderExpired();
    error ZeroSellAmount();
    error ZeroBuyAmount();
    error TokenNotWhitelisted();
    error NotMakerOrTakerRelayer();
    error NullifierAlreadySpent();
    error DeadlineExpired();
    error SellBuyTokenMismatch();
    error DuplicateClaimsRoot();

    error ClaimsGroupAlreadyExists();

    uint256 internal constant FEE_BPS_DENOMINATOR = 10_000;

    // ─── Structs (shared with PrivateSettlement) ────────────────

    struct ClaimsGroup {
        uint128 totalLocked;
        uint128 totalClaimed;
        address token;
        // Circuit tier the originating settlement was proven against —
        // claimWithProof needs it to dispatch to the matching tier-N
        // claim verifier (each tier has its own claimsTreeDepth, so a
        // single claim circuit cannot serve all tiers). Stored on the
        // group rather than re-derived from the proof so recipients
        // never have to know the tier their settlement used.
        uint8 tier;
    }
    struct AuthorizeProof {
        uint[2] proofA;
        uint[2][2] proofB;
        uint[2] proofC;
        bytes32 pubKeyBind;
        uint256 commitmentRoot;
        bytes32 nullifier;
        bytes32 nonceNullifier;
        bytes32 newCommitment;
        address sellToken;
        address buyToken;
        uint128 sellAmount;
        uint128 buyAmount;
        uint16  maxFee;
        uint64  expiry;
        bytes32 claimsRoot;
        uint128 totalLocked;
        address relayer;
        bytes32 orderHash;
        // Tier selects which authorize.circom variant produced this proof —
        // tier 16 is the only circuit live today, but keeping the field on
        // the struct lets the verifier registry on PrivateSettlement
        // dispatch to the right Groth16 verifier when 64 / 128 ship.
        // The Groth16 public signals (packAuthSignals) are unchanged across
        // tiers — claimsRoot already hashes the variable-length claims set
        // inside the circuit — so this byte never reaches the verifier.
        uint8 tier;
    }

    // ─── Pack helpers (pure) ────────────────────────────────────

    /// @notice Pack an AuthorizeProof into the 15-element public-signal
    ///         array expected by authorize.circom's Groth16 verifier.
    function packAuthSignals(AuthorizeProof calldata ap)
        external
        pure
        returns (uint[15] memory signals)
    {
        signals[0]  = uint256(ap.pubKeyBind);
        signals[1]  = ap.commitmentRoot;
        signals[2]  = uint256(ap.nullifier);
        signals[3]  = uint256(ap.nonceNullifier);
        signals[4]  = uint256(ap.newCommitment);
        signals[5]  = uint256(uint160(ap.sellToken));
        signals[6]  = uint256(uint160(ap.buyToken));
        signals[7]  = uint256(ap.sellAmount);
        signals[8]  = uint256(ap.buyAmount);
        signals[9]  = uint256(ap.maxFee);
        signals[10] = uint256(ap.expiry);
        signals[11] = uint256(ap.claimsRoot);
        signals[12] = uint256(ap.totalLocked);
        signals[13] = uint256(uint160(ap.relayer));
        signals[14] = uint256(ap.orderHash);
    }

    // ─── Cross-side validators for settleAuth ──────────────────

    /// @notice Validate the maker/taker cross-side invariants for settleAuth:
    ///         non-zero amounts, token whitelist, token compatibility, price,
    ///         claims+fee cap, fee upper bound, and per-side expiry.
    ///         Pure + storage-mapping parameter — reverts on any violation.
    function validateCrossSide(
        AuthorizeProof calldata maker,
        AuthorizeProof calldata taker,
        uint96 feeTokenMaker,
        uint96 feeTokenTaker,
        mapping(address => bool) storage whitelistedTokens
    ) external view {
        // Non-zero amounts
        if (maker.sellAmount == 0 || taker.sellAmount == 0) revert ZeroSellAmount();
        if (maker.buyAmount == 0 || taker.buyAmount == 0) revert ZeroBuyAmount();

        // Token whitelist (sell tokens; buy tokens covered transitively by C1)
        if (!whitelistedTokens[maker.sellToken]) revert TokenNotWhitelisted();
        if (!whitelistedTokens[taker.sellToken]) revert TokenNotWhitelisted();

        // C1: cross-side token compatibility
        if (maker.sellToken != taker.buyToken) revert TokenSidesMismatch();
        if (taker.sellToken != maker.buyToken) revert TokenSidesMismatch();

        // C2: cross-side price
        uint256 makerProduct = uint256(maker.sellAmount) * uint256(taker.sellAmount);
        uint256 takerProduct = uint256(maker.buyAmount) * uint256(taker.buyAmount);
        if (takerProduct > makerProduct) revert PriceMismatch();

        // C4: claims + fee cap
        if (uint256(maker.totalLocked) + uint256(feeTokenMaker) > uint256(taker.sellAmount)) {
            revert ClaimsCapExceeded();
        }
        if (uint256(taker.totalLocked) + uint256(feeTokenTaker) > uint256(maker.sellAmount)) {
            revert ClaimsCapExceeded();
        }

        // Fee upper bound (user-signed maxFee, bps).
        // [2026-04-14 fee-semantics redesign] Each side's maxFee caps the
        // fee charged against their OWN buyAmount (receive token), so the
        // user locks in what they pay their relayer when signing — the
        // counterparty's maxFee can't inflate it.
        if (uint256(feeTokenMaker) * FEE_BPS_DENOMINATOR > uint256(maker.buyAmount) * uint256(maker.maxFee)) {
            revert FeeExceedsMax();
        }
        if (uint256(feeTokenTaker) * FEE_BPS_DENOMINATOR > uint256(taker.buyAmount) * uint256(taker.maxFee)) {
            revert FeeExceedsMax();
        }

        // Per-side expiry
        if (block.timestamp > maker.expiry) revert OrderExpired();
        if (block.timestamp > taker.expiry) revert OrderExpired();
    }

    /// @notice Calldata-only validation for settleWithDex (pre-state-mutation).
    ///         Does not include storage-dependent checks (whitelist, nullifier
    ///         double-spend, root recency) — those stay inline.
    function validateDexProof(
        AuthorizeProof calldata proof,
        address sender,
        uint256 deadline,
        mapping(address => bool) storage whitelistedTokens
    ) external view {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (sender != proof.relayer) revert NotMakerOrTakerRelayer();
        if (proof.sellToken == proof.buyToken) revert TokenSidesMismatch();
        if (!whitelistedTokens[proof.sellToken]) revert TokenNotWhitelisted();
        if (!whitelistedTokens[proof.buyToken]) revert TokenNotWhitelisted();
        if (proof.sellAmount == 0) revert ZeroSellAmount();
        if (block.timestamp > proof.expiry) revert OrderExpired();
        if (proof.nullifier == proof.nonceNullifier) revert NullifierAlreadySpent();
    }

    /// @notice Calldata-only validation for scatterDirectAuth (pre-state-mutation).
    ///         Handles relayer binding, same-token invariant, non-zero amounts,
    ///         fee cap, claims+fee cap, and expiry.
    function validateScatterAuth(
        AuthorizeProof calldata ap,
        address sender,
        uint96 fee,
        mapping(address => bool) storage whitelistedTokens
    ) external view {
        if (sender != ap.relayer) revert NotMakerOrTakerRelayer();
        if (ap.sellToken != ap.buyToken) revert SellBuyTokenMismatch();
        if (!whitelistedTokens[ap.sellToken]) revert TokenNotWhitelisted();
        if (ap.sellAmount == 0) revert ZeroSellAmount();
        if (ap.buyAmount == 0) revert ZeroBuyAmount();
        if (uint256(fee) * FEE_BPS_DENOMINATOR > uint256(ap.sellAmount) * uint256(ap.maxFee)) {
            revert FeeExceedsMax();
        }
        if (uint256(ap.totalLocked) + uint256(fee) > uint256(ap.sellAmount)) {
            revert ClaimsCapExceeded();
        }
        if (block.timestamp > ap.expiry) revert OrderExpired();
    }

    /// @notice Guard against two sides sharing the same `claimsRoot` when
    ///         both have non-zero locked amounts (would otherwise collide in
    ///         the claims-group registry). One-sided settles are permitted.
    function requireDistinctClaimsRoots(
        bytes32 rootA,
        bytes32 rootB,
        uint128 lockedA,
        uint128 lockedB
    ) external pure {
        if (rootA == rootB && lockedA > 0 && lockedB > 0) revert DuplicateClaimsRoot();
    }

    /// @notice Insert a residual commitment into the pool iff non-zero.
    /// @dev `internal` so call sites inline via JUMP instead of DELEGATECALL —
    ///      body is trivial and the per-call dispatch overhead wasn't worth it.
    function maybeInsertCommitment(CommitmentPool pool, bytes32 commitment) internal {
        if (commitment != bytes32(0)) {
            // Leaf index returned by the pool is consumed via the off-chain CommitmentInserted event.
            // slither-disable-next-line unused-return
            pool.insertCommitment(uint256(commitment));
        }
    }

    /// @notice Register a new claims group. Reverts if one already exists at `root`.
    /// @dev `internal` — same reasoning as `maybeInsertCommitment`.
    function registerClaimsGroup(
        mapping(bytes32 => ClaimsGroup) storage claimsGroups,
        bytes32 root,
        address token,
        uint128 totalLocked,
        uint8 tier
    ) internal {
        if (claimsGroups[root].token != address(0)) revert ClaimsGroupAlreadyExists();
        claimsGroups[root] = ClaimsGroup({
            totalLocked: totalLocked,
            totalClaimed: 0,
            token: token,
            tier: tier
        });
    }
}
