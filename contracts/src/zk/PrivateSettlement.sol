// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {CommitmentPool} from "./CommitmentPool.sol";
import {ISettleVerifier} from "./ISettleVerifier.sol";
import {IClaimVerifier} from "./IClaimVerifier.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

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
    error ExceedsTotalLocked();
    error RenounceOwnershipDisabled();
    error TokenNotWhitelisted();
    error NotYetReleasable();
    error TokenMismatch();
    error AmountOverflow();
    error OnlyWETH();
    error ClaimsGroupAlreadyExists();
    error TimestampOutOfRange();

    // ─── Events ──────────────────────────────────────────────────
    event PrivateSettled(
        bytes32 indexed makerNullifier,
        bytes32 indexed takerNullifier,
        bytes32 claimsRootMaker,
        bytes32 claimsRootTaker,
        address relayer,
        uint96 feeTokenMaker,
        uint96 feeTokenTaker
    );
    event PrivateClaim(
        bytes32 indexed claimsRoot,
        bytes32 indexed nullifier,
        address indexed recipient,
        address token,
        uint256 amount
    );
    // ─── Data Structures ─────────────────────────────────────────
    // Packed into 2 storage slots:
    // Slot 0: token (20 bytes) + totalLocked (12 bytes) = 32 bytes
    // Slot 1: totalClaimed (12 bytes) + _pad (20 bytes) = 32 bytes
    struct ClaimsGroup {
        address token;          // slot 0: 20 bytes
        uint96  totalLocked;    // slot 0: 12 bytes
        uint96  totalClaimed;   // slot 1: 12 bytes
    }

    // ─── State ───────────────────────────────────────────────────
    CommitmentPool public immutable pool;
    ISettleVerifier public immutable settleVerifier;
    IClaimVerifier public immutable claimVerifier;
    address public immutable weth;

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
        address _claimVerifier,
        address _weth
    ) Ownable(msg.sender) {
        if (_pool == address(0) || _settleVerifier == address(0) || _claimVerifier == address(0) || _weth == address(0))
            revert ZeroAddress();
        pool = CommitmentPool(_pool);
        settleVerifier = ISettleVerifier(_settleVerifier);
        claimVerifier = IClaimVerifier(_claimVerifier);
        weth = _weth;
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
        uint96 feeTokenMaker;   // fee in tokenMaker (from taker's sell, paid to relayer)
        uint96 feeTokenTaker;   // fee in tokenTaker (from maker's sell, paid to relayer)
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

        uint[16] memory pubSignals = [
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
            uint256(p.feeTokenMaker),
            uint256(p.feeTokenTaker),
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

        // Transfer claim amounts from CommitmentPool to this contract.
        // After settlement, PrivateSettlement holds the tokens and distributes
        // them via claimWithProof(). Claims are permanently available.
        if (p.totalLockedMaker > 0) {
            pool.transferToSettlement(p.tokenMaker, p.totalLockedMaker);
        }
        if (p.totalLockedTaker > 0) {
            pool.transferToSettlement(p.tokenTaker, p.totalLockedTaker);
        }

        // Transfer fees from pool directly to relayer (msg.sender)
        if (p.feeTokenMaker > 0) {
            pool.transferFee(msg.sender, p.tokenMaker, p.feeTokenMaker);
        }
        if (p.feeTokenTaker > 0) {
            pool.transferFee(msg.sender, p.tokenTaker, p.feeTokenTaker);
        }

        if (claimsGroups[p.claimsRootMaker].totalLocked != 0) revert ClaimsGroupAlreadyExists();
        claimsGroups[p.claimsRootMaker] = ClaimsGroup({
            token: p.tokenMaker,
            totalLocked: p.totalLockedMaker,
            totalClaimed: 0
        });
        if (claimsGroups[p.claimsRootTaker].totalLocked != 0) revert ClaimsGroupAlreadyExists();
        claimsGroups[p.claimsRootTaker] = ClaimsGroup({
            token: p.tokenTaker,
            totalLocked: p.totalLockedTaker,
            totalClaimed: 0
        });

        emit PrivateSettled(p.makerNullifier, p.takerNullifier, p.claimsRootMaker, p.claimsRootTaker, msg.sender, p.feeTokenMaker, p.feeTokenTaker);
    }

    // ─── Scatter Direct (same-token, no counterparty) ─────────────

    struct ScatterDirectParams {
        uint[2] proofA;
        uint[2][2] proofB;
        uint[2] proofC;
        uint256 currentRoot;
        bytes32 nullifier;
        bytes32 newCommitment;
        address token;
        uint256 withdrawAmount;      // total amount withdrawn from commitment
        bytes32 claimsRoot;
        uint96 totalLocked;          // sum of claim amounts
        uint96 fee;                  // relayer fee
    }

    event ScatterDirect(
        bytes32 indexed nullifier,
        bytes32 indexed claimsRoot,
        address relayer,
        uint96 fee
    );

    /// @notice Single-party scatter: consume a commitment and register claims directly.
    ///         Uses withdraw proof — no counterparty or settle circuit needed.
    ///         For same-token orders (e.g., scheduled transfers).
    function scatterDirect(ScatterDirectParams calldata p) external nonReentrant {
        if (paused) revert ContractPaused();
        if (!whitelistedTokens[p.token]) revert TokenNotWhitelisted();
        if (nullifiers[p.nullifier]) revert NullifierAlreadySpent();

        // withdrawAmount must exactly equal claims + fee (no surplus left in contract)
        if (p.withdrawAmount != uint256(p.totalLocked) + uint256(p.fee)) revert AmountOverflow();

        // Verify root is known
        if (!pool.isKnownRoot(p.currentRoot)) revert UnknownRoot();

        // Withdraw from pool: recipient = this contract, relayer = msg.sender
        pool.withdrawFor(
            p.proofA, p.proofB, p.proofC,
            p.currentRoot,
            uint256(p.nullifier),
            uint256(p.newCommitment),
            p.token,
            p.withdrawAmount,
            address(this),   // funds come to PrivateSettlement
            msg.sender       // relayer bound in proof
        );

        // Mark nullifier
        nullifiers[p.nullifier] = true;

        // Register claims group (prevent overwriting existing group)
        if (claimsGroups[p.claimsRoot].totalLocked != 0) revert ClaimsGroupAlreadyExists();
        claimsGroups[p.claimsRoot] = ClaimsGroup({
            token: p.token,
            totalLocked: p.totalLocked,
            totalClaimed: 0
        });

        // Transfer fee to relayer
        if (p.fee > 0) {
            IERC20(p.token).safeTransfer(msg.sender, p.fee);
        }

        emit ScatterDirect(p.nullifier, p.claimsRoot, msg.sender, p.fee);
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

        // Transfer tokens — unwrap WETH to ETH if applicable
        if (token == weth) {
            IWETH(weth).withdraw(amount);
            Address.sendValue(payable(recipient), amount);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }

        emit PrivateClaim(claimsRoot, claimNullifier, recipient, token, amount);
    }

    /// @dev Accept ETH only from WETH.withdraw() during claimWithProof().
    receive() external payable {
        if (msg.sender != weth) revert OnlyWETH();
    }

    // Claims are permanently claimable — no expiry or refund mechanism.
    // Claim holders can claim at any time after releaseTime with a valid ZK proof.
}
