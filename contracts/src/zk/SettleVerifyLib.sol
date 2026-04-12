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

    error ClaimsGroupAlreadyExists();

    uint256 internal constant FEE_BPS_DENOMINATOR = 10_000;

    // ─── Structs (shared with PrivateSettlement) ────────────────

    struct ClaimsGroup {
        uint128 totalLocked;
        uint128 totalClaimed;
        address token;
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
    }

    struct SettleParams {
        uint[2] proofA;
        uint[2][2] proofB;
        uint[2] proofC;
        uint256 currentRoot;
        uint256 currentTimestamp;
        bytes32 makerNullifier;
        bytes32 takerNullifier;
        bytes32 makerNonceNullifier;
        bytes32 takerNonceNullifier;
        bytes32 makerNewCommitment;
        bytes32 takerNewCommitment;
        bytes32 claimsRootMaker;
        bytes32 claimsRootTaker;
        uint128 totalLockedMaker;
        uint128 totalLockedTaker;
        address tokenMaker;
        address tokenTaker;
        uint96 feeTokenMaker;
        uint96 feeTokenTaker;
        address makerRelayer;
        address takerRelayer;
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

    /// @notice Pack SettleParams into the 18-element public-signal array
    ///         expected by settle.circom's Groth16 verifier.
    function packSettleSignals(SettleParams calldata p)
        external
        pure
        returns (uint[18] memory signals)
    {
        signals[0]  = p.currentRoot;
        signals[1]  = uint256(p.makerNullifier);
        signals[2]  = uint256(p.takerNullifier);
        signals[3]  = uint256(p.makerNonceNullifier);
        signals[4]  = uint256(p.takerNonceNullifier);
        signals[5]  = uint256(p.makerNewCommitment);
        signals[6]  = uint256(p.takerNewCommitment);
        signals[7]  = uint256(p.claimsRootMaker);
        signals[8]  = uint256(p.claimsRootTaker);
        signals[9]  = uint256(p.totalLockedMaker);
        signals[10] = uint256(p.totalLockedTaker);
        signals[11] = uint256(uint160(p.tokenMaker));
        signals[12] = uint256(uint160(p.tokenTaker));
        signals[13] = uint256(p.feeTokenMaker);
        signals[14] = uint256(p.feeTokenTaker);
        signals[15] = p.currentTimestamp;
        signals[16] = uint256(uint160(p.makerRelayer));
        signals[17] = uint256(uint160(p.takerRelayer));
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

        // Fee upper bound (user-signed maxFee, bps)
        if (uint256(feeTokenMaker) * FEE_BPS_DENOMINATOR > uint256(taker.sellAmount) * uint256(taker.maxFee)) {
            revert FeeExceedsMax();
        }
        if (uint256(feeTokenTaker) * FEE_BPS_DENOMINATOR > uint256(maker.sellAmount) * uint256(maker.maxFee)) {
            revert FeeExceedsMax();
        }

        // Per-side expiry
        if (block.timestamp > maker.expiry) revert OrderExpired();
        if (block.timestamp > taker.expiry) revert OrderExpired();
    }

    /// @notice Validate per-side caps for a single authorize trade
    ///         (scatterDirectAuth / settleWithDex).
    ///         Checks fee-vs-sellAmount bound, claims+fee <= sellAmount,
    ///         and expiry. `sellAmount` non-zero must already be checked
    ///         by the caller (the multiplications below tolerate 0 but
    ///         the caller must still reject zero-sell orders for other
    ///         reasons — transfer semantics, etc.).
    function validateAuthCaps(
        uint128 sellAmount,
        uint16  maxFee,
        uint64  expiry,
        uint128 totalLocked,
        uint96  fee
    ) external view {
        if (uint256(fee) * FEE_BPS_DENOMINATOR > uint256(sellAmount) * uint256(maxFee)) {
            revert FeeExceedsMax();
        }
        if (uint256(totalLocked) + uint256(fee) > uint256(sellAmount)) {
            revert ClaimsCapExceeded();
        }
        if (block.timestamp > expiry) revert OrderExpired();
    }

    /// @notice Pack claim public signals for claim.circom verifier.
    function packClaimSignals(
        bytes32 claimsRoot,
        bytes32 claimNullifier,
        uint256 amount,
        address token,
        address recipient,
        uint256 releaseTime
    ) external pure returns (uint[6] memory signals) {
        signals[0] = uint256(claimsRoot);
        signals[1] = uint256(claimNullifier);
        signals[2] = amount;
        signals[3] = uint256(uint160(token));
        signals[4] = uint256(uint160(recipient));
        signals[5] = releaseTime;
    }

    /// @notice Insert a residual commitment into the pool iff non-zero.
    ///         Called after state mutations in settle/scatter functions to
    ///         record the change UTXO.
    function maybeInsertCommitment(CommitmentPool pool, bytes32 commitment) external {
        if (commitment != bytes32(0)) {
            pool.insertCommitment(uint256(commitment));
        }
    }

    /// @notice Register a new claims group. Reverts if one already exists at `root`.
    function registerClaimsGroup(
        mapping(bytes32 => ClaimsGroup) storage claimsGroups,
        bytes32 root,
        address token,
        uint128 totalLocked
    ) external {
        if (claimsGroups[root].token != address(0)) revert ClaimsGroupAlreadyExists();
        claimsGroups[root] = ClaimsGroup({
            totalLocked: totalLocked,
            totalClaimed: 0,
            token: token
        });
    }

    /// @notice Pack cancel public signals for cancel.circom verifier.
    function packCancelSignals(
        uint256 commitmentRoot,
        bytes32 oldNullifier,
        bytes32 oldNonceNullifier,
        bytes32 newCommitment,
        address sender
    ) external pure returns (uint[5] memory signals) {
        signals[0] = commitmentRoot;
        signals[1] = uint256(oldNullifier);
        signals[2] = uint256(oldNonceNullifier);
        signals[3] = uint256(newCommitment);
        signals[4] = uint256(uint160(sender));
    }
}
