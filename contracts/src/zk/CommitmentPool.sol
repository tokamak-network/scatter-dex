// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {PoseidonT2} from "poseidon-solidity/PoseidonT2.sol";
import {IncrementalMerkleTree} from "./IncrementalMerkleTree.sol";
import {IVerifier} from "./IVerifier.sol";

/// @title CommitmentPool
/// @notice UTXO-based private escrow using Poseidon Merkle tree and Groth16 ZK proofs.
/// @dev Users deposit tokens by submitting a commitment (leaf in Merkle tree).
///      Withdrawals require a ZK proof of commitment ownership + nullifier.
///      Commitment = Poseidon(ownerSecret, token, amount, salt)
///      Nullifier  = Poseidon(ownerSecret, salt)
contract CommitmentPool is IncrementalMerkleTree, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Errors ──────────────────────────────────────────────────
    error ZeroAmount();
    error ZeroAddress();
    error ZeroCommitment();
    error TokenNotWhitelisted();
    error UnknownRoot();
    error NullifierAlreadySpent();
    error InvalidProof();
    error ContractPaused();
    error RenounceOwnershipDisabled();
    error NotAuthorizedSettlement();
    error InsufficientPoolBalance();

    // ─── Events ──────────────────────────────────────────────────
    event CommitmentInserted(
        uint256 indexed commitment,
        uint32 leafIndex,
        uint256 timestamp
    );
    event Withdrawal(
        address indexed recipient,
        uint256 nullifierHash,
        uint256 newCommitment,
        uint256 amount
    );

    // ─── State ───────────────────────────────────────────────────
    IVerifier public immutable withdrawVerifier;
    address public authorizedSettlement;
    bool public paused;

    mapping(uint256 => bool) public nullifiers;
    mapping(address => bool) public whitelistedTokens;

    // ─── Constructor ─────────────────────────────────────────────
    constructor(
        address _withdrawVerifier,
        uint32 _treeLevels,
        uint32 _rootHistorySize
    )
        IncrementalMerkleTree(_treeLevels, _rootHistorySize)
        Ownable(msg.sender)
    {
        if (_withdrawVerifier == address(0)) revert ZeroAddress();
        withdrawVerifier = IVerifier(_withdrawVerifier);
    }

    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    function transferOwnership(address newOwner) public override {
        if (newOwner == address(0)) revert ZeroAddress();
        super.transferOwnership(newOwner);
    }

    event Paused(bool paused);
    event TokenWhitelistUpdated(address indexed token, bool allowed);
    event AuthorizedSettlementUpdated(address indexed settlement);

    function setAuthorizedSettlement(address _settlement) external onlyOwner {
        if (_settlement == address(0)) revert ZeroAddress();
        authorizedSettlement = _settlement;
        emit AuthorizedSettlementUpdated(_settlement);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setTokenWhitelist(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        whitelistedTokens[token] = allowed;
        emit TokenWhitelistUpdated(token, allowed);
    }

    // ─── Deposit ─────────────────────────────────────────────────

    /// @notice Deposit tokens and add a commitment to the Merkle tree.
    /// @dev commitment = Poseidon(ownerSecret, token, amount, salt) computed off-chain.
    ///      The contract does NOT verify the commitment preimage — if the user submits
    ///      a malformed commitment, only they are harmed (can't withdraw later).
    /// @param commitment The Poseidon hash commitment (leaf value)
    /// @param token The ERC20 token being deposited
    /// @param amount The amount being deposited
    function deposit(uint256 commitment, address token, uint256 amount) external nonReentrant {
        if (paused) revert ContractPaused();
        if (commitment == 0) revert ZeroCommitment();
        if (token == address(0)) revert ZeroAddress();
        if (!whitelistedTokens[token]) revert TokenNotWhitelisted();
        if (amount == 0) revert ZeroAmount();

        // Transfer tokens to this contract
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Insert commitment into Merkle tree
        uint32 leafIndex = _insert(commitment);

        emit CommitmentInserted(commitment, leafIndex, block.timestamp);
    }

    // ─── Insert (from PrivateSettlement) ──────────────────────────

    /// @notice Insert a new commitment into the Merkle tree.
    /// @dev Only callable by the authorized PrivateSettlement contract.
    ///      Used to insert change commitments after a private settlement.
    function insertCommitment(uint256 commitment) external returns (uint32) {
        if (msg.sender != authorizedSettlement) revert NotAuthorizedSettlement();
        // Zero commitments are valid — they represent empty change UTXOs
        // when a party's entire balance is consumed during settlement.
        if (commitment == 0) return 0;
        uint32 leafIndex = _insert(commitment);
        emit CommitmentInserted(commitment, leafIndex, block.timestamp);
        return leafIndex;
    }

    /// @notice Transfer tokens from pool to PrivateSettlement for claim distribution.
    /// @dev Only callable by the authorized PrivateSettlement contract.
    ///      Called during settlePrivate() to move claim amounts to the settlement
    ///      contract, which then distributes them via claimWithProof().
    function transferToSettlement(address token, uint256 amount) external nonReentrant {
        if (msg.sender != authorizedSettlement) revert NotAuthorizedSettlement();
        if (IERC20(token).balanceOf(address(this)) < amount) revert InsufficientPoolBalance();
        IERC20(token).safeTransfer(authorizedSettlement, amount);
    }

    event FeeTransferred(address indexed recipient, address indexed token, uint256 amount);

    /// @notice Transfer fee tokens from pool to a recipient (e.g., relayer).
    /// @dev Only callable by the authorized PrivateSettlement contract.
    function transferFee(address recipient, address token, uint256 amount) external nonReentrant {
        if (msg.sender != authorizedSettlement) revert NotAuthorizedSettlement();
        if (recipient == address(0)) revert ZeroAddress();
        if (IERC20(token).balanceOf(address(this)) < amount) revert InsufficientPoolBalance();
        IERC20(token).safeTransfer(recipient, amount);
        emit FeeTransferred(recipient, token, amount);
    }

    // ─── Withdraw ────────────────────────────────────────────────

    /// @notice Withdraw tokens by proving ownership of a commitment via ZK proof.
    /// @dev The proof verifies:
    ///   1. The prover knows (ownerSecret, token, amount, salt) for a commitment in the tree
    ///   2. nullifierHash = Poseidon(ownerSecret, salt) — prevents double-spend
    ///   3. withdrawAmount <= amount in commitment
    ///   4. newCommitment = Poseidon(ownerSecret, token, changeAmount, newSalt) if change > 0
    ///   5. tokenHash = Poseidon(token) — binds to correct token
    ///   6. recipient and relayer are bound in the proof
    /// @param proofA Groth16 proof point A
    /// @param proofB Groth16 proof point B
    /// @param proofC Groth16 proof point C
    /// @param root The Merkle root used in the proof (must be a known root)
    /// @param nullifierHash The nullifier to prevent double-spending
    /// @param newCommitment The change commitment (0 if full withdrawal)
    /// @param token The token being withdrawn
    /// @param amount The amount being withdrawn
    /// @param recipient The address receiving the tokens
    /// @param relayer The relayer address (address(0) if self-withdraw)
    function withdraw(
        uint[2] calldata proofA,
        uint[2][2] calldata proofB,
        uint[2] calldata proofC,
        uint256 root,
        uint256 nullifierHash,
        uint256 newCommitment,
        address token,
        uint256 amount,
        address recipient,
        address relayer
    ) external nonReentrant {
        if (paused) revert ContractPaused();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (!isKnownRoot(root)) revert UnknownRoot();
        if (nullifiers[nullifierHash]) revert NullifierAlreadySpent();

        // Compute tokenHash = Poseidon(token) to match circuit's public input
        // Cast to uint160 is safe: Ethereum addresses are exactly 160 bits, so no truncation occurs.
        uint256 tokenHash = PoseidonT2.hash([uint256(uint160(token))]);

        // Verify ZK proof
        // Public signals: [root, nullifierHash, newCommitment, tokenHash, withdrawAmount, recipient, relayer]
        uint[7] memory pubSignals = [
            root,
            nullifierHash,
            newCommitment,
            tokenHash,
            amount,
            uint256(uint160(recipient)),
            uint256(uint160(relayer))
        ];

        if (!withdrawVerifier.verifyProof(proofA, proofB, proofC, pubSignals)) {
            revert InvalidProof();
        }

        // Mark nullifier as spent
        nullifiers[nullifierHash] = true;

        // Insert change commitment if non-zero
        if (newCommitment != 0) {
            uint32 changeLeaf = _insert(newCommitment);
            emit CommitmentInserted(newCommitment, changeLeaf, block.timestamp);
        }

        // Transfer tokens to recipient
        IERC20(token).safeTransfer(recipient, amount);

        emit Withdrawal(recipient, nullifierHash, newCommitment, amount);
    }

    /// @notice Withdraw on behalf of PrivateSettlement (for scatterDirect).
    /// @dev Only callable by the authorized PrivateSettlement contract.
    ///      Same logic as withdraw() but called by settlement, not the user.
    function withdrawFor(
        uint[2] calldata proofA,
        uint[2][2] calldata proofB,
        uint[2] calldata proofC,
        uint256 root,
        uint256 nullifierHash,
        uint256 newCommitment,
        address token,
        uint256 amount,
        address recipient,
        address relayer
    ) external nonReentrant {
        if (msg.sender != authorizedSettlement) revert NotAuthorizedSettlement();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (!isKnownRoot(root)) revert UnknownRoot();
        if (nullifiers[nullifierHash]) revert NullifierAlreadySpent();

        uint256 tokenHash = PoseidonT2.hash([uint256(uint160(token))]);

        uint[7] memory pubSignals = [
            root,
            nullifierHash,
            newCommitment,
            tokenHash,
            amount,
            uint256(uint160(recipient)),
            uint256(uint160(relayer))
        ];

        if (!withdrawVerifier.verifyProof(proofA, proofB, proofC, pubSignals)) {
            revert InvalidProof();
        }

        nullifiers[nullifierHash] = true;

        if (newCommitment != 0) {
            uint32 changeLeaf = _insert(newCommitment);
            emit CommitmentInserted(newCommitment, changeLeaf, block.timestamp);
        }

        IERC20(token).safeTransfer(recipient, amount);

        emit Withdrawal(recipient, nullifierHash, newCommitment, amount);
    }
}
