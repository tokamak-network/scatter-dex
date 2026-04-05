// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {CommitmentPool} from "./CommitmentPool.sol";
import {ISettleVerifier} from "./ISettleVerifier.sol";
import {IClaimVerifier} from "./IClaimVerifier.sol";

/// @title PrivateSettlement
/// @notice ZK-based private settlement for ScatterDEX.
///         settle: ZK proof hides maker/taker, amounts, and claims structure.
///         claim: ZK proof proves membership in claimsRoot without revealing which settle.
contract PrivateSettlement is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Errors ──────────────────────────────────────────────────
    error ZeroAddress();
    error ContractPaused();
    error UnknownRoot();
    error NullifierAlreadySpent();
    error InvalidProof();
    error ClaimsGroupNotFound();
    error ClaimsGroupExpired();
    error ExceedsTotalLocked();
    error NotExpired();
    error RenounceOwnershipDisabled();
    error TokenNotWhitelisted();
    error NotYetReleasable();
    error TokenMismatch();
    error AmountOverflow();
    error TimestampOutOfRange();

    // ─── Events ──────────────────────────────────────────────────
    event PrivateSettled(
        bytes32 indexed makerNullifier,
        bytes32 indexed takerNullifier,
        bytes32 claimsRootMaker,
        bytes32 claimsRootTaker
    );
    event PrivateClaim(
        bytes32 indexed claimsRoot,
        bytes32 indexed nullifier,
        address indexed recipient,
        address token,
        uint256 amount
    );
    event ClaimsGroupRefunded(
        bytes32 indexed claimsRoot,
        address indexed token,
        uint256 amount
    );

    // ─── Data Structures ─────────────────────────────────────────
    // Packed: 2 storage slots
    // Slot 0: token (20) + expiry (6) + _pad (6) = 32 bytes
    // Slot 1: totalLocked (12) + totalClaimed (12) + _pad (8) = 32 bytes
    struct ClaimsGroup {
        address token;          // slot 0: 20 bytes
        uint48  expiry;         // slot 0: 6 bytes
        uint96  totalLocked;    // slot 1: 12 bytes
        uint96  totalClaimed;   // slot 1: 12 bytes
    }

    // ─── State ───────────────────────────────────────────────────
    CommitmentPool public immutable pool;
    ISettleVerifier public immutable settleVerifier;
    IClaimVerifier public immutable claimVerifier;

    uint256 public constant REFUND_WINDOW = 7 days;
    uint256 public constant TIMESTAMP_TOLERANCE = 300; // 5 minutes
    bool public paused;

    mapping(bytes32 => bool) public nullifiers;       // escrow nullifiers
    mapping(bytes32 => bool) public nonceNullifiers;   // nonce nullifiers
    mapping(bytes32 => bool) public claimNullifiers;   // claim nullifiers
    mapping(bytes32 => ClaimsGroup) public claimsGroups;
    mapping(address => bool) public whitelistedTokens;

    // ─── Constructor ─────────────────────────────────────────────
    constructor(
        address _pool,
        address _settleVerifier,
        address _claimVerifier
    ) Ownable(msg.sender) {
        if (_pool == address(0) || _settleVerifier == address(0) || _claimVerifier == address(0))
            revert ZeroAddress();
        pool = CommitmentPool(_pool);
        settleVerifier = ISettleVerifier(_settleVerifier);
        claimVerifier = IClaimVerifier(_claimVerifier);
    }

    function renounceOwnership() public pure override { revert RenounceOwnershipDisabled(); }
    function setPaused(bool _paused) external onlyOwner { paused = _paused; }
    function setTokenWhitelist(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        whitelistedTokens[token] = allowed;
    }

    // ─── Settle ──────────────────────────────────────────────────

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
        uint96 totalLockedMaker;
        uint96 totalLockedTaker;
        address tokenMaker;
        address tokenTaker;
        uint256 totalFee;
    }

    /// @notice Execute a private settlement with ZK proof.
    function settlePrivate(SettleParams calldata p) external nonReentrant {
        if (paused) revert ContractPaused();
        if (!whitelistedTokens[p.tokenMaker]) revert TokenNotWhitelisted();
        if (!whitelistedTokens[p.tokenTaker]) revert TokenNotWhitelisted();

        if (nullifiers[p.makerNullifier]) revert NullifierAlreadySpent();
        if (nullifiers[p.takerNullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[p.makerNonceNullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[p.takerNonceNullifier]) revert NullifierAlreadySpent();

        // Verify the caller-provided root is known to the pool (avoids reading stale root)
        if (!pool.isKnownRoot(p.currentRoot)) revert UnknownRoot();

        // Verify the caller-provided timestamp is within tolerance of the actual block timestamp
        if (
            p.currentTimestamp > block.timestamp + TIMESTAMP_TOLERANCE ||
            p.currentTimestamp + TIMESTAMP_TOLERANCE < block.timestamp
        ) revert TimestampOutOfRange();

        uint[15] memory pubSignals = [
            p.currentRoot,
            uint256(p.makerNullifier),
            uint256(p.takerNullifier),
            uint256(p.makerNonceNullifier),
            uint256(p.takerNonceNullifier),
            uint256(p.makerNewCommitment),
            uint256(p.takerNewCommitment),
            uint256(p.claimsRootMaker),
            uint256(p.claimsRootTaker),
            uint256(p.totalLockedMaker),
            uint256(p.totalLockedTaker),
            uint256(uint160(p.tokenMaker)),
            uint256(uint160(p.tokenTaker)),
            p.totalFee,
            p.currentTimestamp
        ];

        if (!settleVerifier.verifyProof(p.proofA, p.proofB, p.proofC, pubSignals)) {
            revert InvalidProof();
        }

        nullifiers[p.makerNullifier] = true;
        nullifiers[p.takerNullifier] = true;
        nonceNullifiers[p.makerNonceNullifier] = true;
        nonceNullifiers[p.takerNonceNullifier] = true;

        // Insert new commitments (change UTXOs) into the CommitmentPool Merkle tree
        if (p.makerNewCommitment != bytes32(0)) {
            pool.insertCommitment(uint256(p.makerNewCommitment));
        }
        if (p.takerNewCommitment != bytes32(0)) {
            pool.insertCommitment(uint256(p.takerNewCommitment));
        }

        uint48 expiry = uint48(block.timestamp) + uint48(REFUND_WINDOW);
        claimsGroups[p.claimsRootMaker] = ClaimsGroup({
            token: p.tokenMaker,
            totalLocked: p.totalLockedMaker,
            totalClaimed: 0,
            expiry: expiry
        });
        claimsGroups[p.claimsRootTaker] = ClaimsGroup({
            token: p.tokenTaker,
            totalLocked: p.totalLockedTaker,
            totalClaimed: 0,
            expiry: expiry
        });

        emit PrivateSettled(p.makerNullifier, p.takerNullifier, p.claimsRootMaker, p.claimsRootTaker);
    }

    // ─── Claim ───────────────────────────────────────────────────

    /// @notice Claim funds from a private settlement using ZK proof.
    ///         Proves membership in a claimsRoot without revealing which settle.
    function claimWithProof(
        uint[2] calldata proofA,
        uint[2][2] calldata proofB,
        uint[2] calldata proofC,
        bytes32 claimsRoot,
        bytes32 claimNullifier,
        uint256 amount,
        address token,
        address recipient,
        uint256 releaseTime
    ) external nonReentrant {
        if (paused) revert ContractPaused();
        if (recipient == address(0)) revert ZeroAddress();

        ClaimsGroup storage group = claimsGroups[claimsRoot];
        if (group.totalLocked == 0) revert ClaimsGroupNotFound();
        if (claimNullifiers[claimNullifier]) revert NullifierAlreadySpent();
        if (amount > type(uint96).max) revert AmountOverflow();
        if (group.totalClaimed + uint96(amount) > group.totalLocked) revert ExceedsTotalLocked();
        if (block.timestamp < releaseTime) revert NotYetReleasable();
        if (token != group.token) revert TokenMismatch();

        // Verify ZK proof
        // Public signals: [claimsRoot, nullifier, amount, token, recipient, releaseTime]
        uint[6] memory pubSignals = [
            uint256(claimsRoot),
            uint256(claimNullifier),
            amount,
            uint256(uint160(token)),
            uint256(uint160(recipient)),
            releaseTime
        ];

        if (!claimVerifier.verifyProof(proofA, proofB, proofC, pubSignals)) {
            revert InvalidProof();
        }

        // Mark nullifier + update claimed
        claimNullifiers[claimNullifier] = true;
        group.totalClaimed += uint96(amount);

        // Transfer tokens
        IERC20(token).safeTransfer(recipient, amount);

        emit PrivateClaim(claimsRoot, claimNullifier, recipient, token, amount);
    }

    // ─── Refund ──────────────────────────────────────────────────

    /// @notice Refund unclaimed funds after expiry.
    ///         Anyone can trigger this; funds go back to the pool.
    function refundClaimsGroup(bytes32 claimsRoot) external nonReentrant {
        ClaimsGroup storage group = claimsGroups[claimsRoot];
        if (group.totalLocked == 0) revert ClaimsGroupNotFound();
        if (block.timestamp < group.expiry) revert NotExpired();

        uint256 unclaimed = group.totalLocked - group.totalClaimed;
        if (unclaimed == 0) return;

        // Mark as fully claimed to prevent re-entry
        group.totalClaimed = group.totalLocked;

        // Return unclaimed tokens to pool contract (can be re-deposited as new commitment)
        IERC20(group.token).safeTransfer(address(pool), unclaimed);

        emit ClaimsGroupRefunded(claimsRoot, group.token, unclaimed);
    }
}
