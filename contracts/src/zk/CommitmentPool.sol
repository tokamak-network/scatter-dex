// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {PoseidonT2} from "poseidon-solidity/PoseidonT2.sol";
import {IncrementalMerkleTree} from "./IncrementalMerkleTree.sol";
import {IVerifier} from "./IVerifier.sol";
import {IDepositVerifier} from "./IDepositVerifier.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";

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
    error FieldElementOutOfRange();
    error NotAContract();
    error FeeOnTransferTokenUnsupported();
    error AddressSanctioned();
    error FeeExceedsMax();
    error TimelockNotExpired();
    error NoPendingSettlement();
    error SettlementAlreadySet();

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
    IDepositVerifier public immutable depositVerifier;
    address public authorizedSettlement;

    /// @dev BN254 scalar field modulus. Public signals fed into a Groth16
    ///      verifier must satisfy `value < BN254_FIELD_MODULUS`; the
    ///      generated verifier enforces this internally via `checkField`,
    ///      but we re-check the deposit inputs upstream so users get a
    ///      precise revert reason and we avoid paying ~150k gas for the
    ///      verifier call on values that cannot possibly verify.
    uint256 internal constant BN254_FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bool public paused;

    mapping(uint256 => bool) public nullifiers;
    mapping(address => bool) public whitelistedTokens;

    /// @notice Optional sanctions list. If set, sanctioned addresses cannot deposit or withdraw.
    ISanctionsList public sanctionsList;

    /// @notice Maximum fee per transferFee call (bps of pool balance). 1000 = 10%.
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice Timelock delay for setAuthorizedSettlement (24 hours).
    uint256 public constant SETTLEMENT_TIMELOCK = 24 hours;

    /// @notice Pending settlement address (2-step change with timelock).
    address public pendingSettlement;
    uint256 public pendingSettlementActivateAt;


    // ─── Constructor ─────────────────────────────────────────────
    constructor(
        address _withdrawVerifier,
        address _depositVerifier,
        uint32 _treeLevels,
        uint32 _rootHistorySize
    )
        IncrementalMerkleTree(_treeLevels, _rootHistorySize)
        Ownable(msg.sender)
    {
        if (_withdrawVerifier == address(0)) revert ZeroAddress();
        if (_depositVerifier == address(0)) revert ZeroAddress();
        // [PR #123 review] Reject EOAs at deploy-time so a fat-fingered
        // address surfaces immediately instead of failing inside verifyProof.
        if (_withdrawVerifier.code.length == 0) revert NotAContract();
        if (_depositVerifier.code.length == 0) revert NotAContract();
        withdrawVerifier = IVerifier(_withdrawVerifier);
        depositVerifier = IDepositVerifier(_depositVerifier);
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

    event SettlementChangeQueued(address indexed newSettlement, uint256 activateAt);

    /// @notice Queue a settlement address change (activates after SETTLEMENT_TIMELOCK).
    function queueSetAuthorizedSettlement(address _settlement) external onlyOwner {
        if (_settlement == address(0)) revert ZeroAddress();
        if (_settlement.code.length == 0) revert NotAContract();
        pendingSettlement = _settlement;
        pendingSettlementActivateAt = block.timestamp + SETTLEMENT_TIMELOCK;
        emit SettlementChangeQueued(_settlement, pendingSettlementActivateAt);
    }

    /// @notice Activate a queued settlement change after timelock expires.
    function activateAuthorizedSettlement() external onlyOwner {
        if (pendingSettlement == address(0)) revert NoPendingSettlement();
        if (block.timestamp < pendingSettlementActivateAt) revert TimelockNotExpired();
        authorizedSettlement = pendingSettlement;
        emit AuthorizedSettlementUpdated(pendingSettlement);
        pendingSettlement = address(0);
        pendingSettlementActivateAt = 0;
    }

    /// @notice Immediate set for initial deployment only (when no settlement is set yet).
    function setAuthorizedSettlement(address _settlement) external onlyOwner {
        if (authorizedSettlement != address(0)) revert SettlementAlreadySet();
        if (_settlement == address(0)) revert ZeroAddress();
        if (_settlement.code.length == 0) revert NotAContract();
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

    event SanctionsListUpdated(address indexed oldList, address indexed newList);

    /// @notice Set the sanctions list. Pass address(0) to disable sanctions checking.
    function setSanctionsList(address _list) external onlyOwner {
        if (_list != address(0) && _list.code.length == 0) revert NotAContract();
        emit SanctionsListUpdated(address(sanctionsList), _list);
        sanctionsList = ISanctionsList(_list);
    }

    /// @dev Revert if address is sanctioned (when sanctions list is configured).
    ///      Caches storage read to avoid double SLOAD when used twice on withdraw.
    modifier notSanctioned(address addr) {
        ISanctionsList _list = sanctionsList;
        if (address(_list) != address(0) && _list.isSanctioned(addr)) {
            revert AddressSanctioned();
        }
        _;
    }

    // ─── Deposit ─────────────────────────────────────────────────

    /// @notice Deposit tokens and add a commitment to the Merkle tree.
    /// @dev commitment = Poseidon(ownerSecret, token, amount, salt) computed off-chain.
    ///      A ZK deposit proof is REQUIRED to bind the on-chain (commitment, token, amount)
    ///      tuple to the Poseidon preimage. Without this, a malicious user could deposit
    ///      1 wei while submitting a commitment claiming an arbitrary balance, then drain
    ///      other users via withdraw / settle proofs.
    ///      See: contracts/test/PoolDrainExploit.t.sol
    /// @param proofA Groth16 deposit proof point A
    /// @param proofB Groth16 deposit proof point B
    /// @param proofC Groth16 deposit proof point C
    /// @param commitment The Poseidon hash commitment (leaf value)
    /// @param token The ERC20 token being deposited
    /// @param amount The amount being deposited
    function deposit(
        uint[2] calldata proofA,
        uint[2][2] calldata proofB,
        uint[2] calldata proofC,
        uint256 commitment,
        address token,
        uint256 amount
    ) external nonReentrant notSanctioned(msg.sender) {
        if (paused) revert ContractPaused();
        if (commitment == 0) revert ZeroCommitment();
        if (token == address(0)) revert ZeroAddress();
        if (!whitelistedTokens[token]) revert TokenNotWhitelisted();
        if (amount == 0) revert ZeroAmount();

        // [PR #123 review] Reject out-of-field commitment / amount upfront so
        // the user gets a precise revert reason and we don't waste gas on a
        // verifier call that is guaranteed to fail. The auto-generated
        // Groth16 verifier already enforces `value < BN254_FIELD_MODULUS`
        // for every public signal via its internal `checkField`, but
        // failing there costs ~150k gas and surfaces only as `InvalidProof`.
        // `token` is a uint160 by type so it cannot exceed the field.
        if (commitment >= BN254_FIELD_MODULUS) revert FieldElementOutOfRange();
        if (amount >= BN254_FIELD_MODULUS) revert FieldElementOutOfRange();

        // Verify the commitment binds to (token, amount)
        // Public signals: [commitment, token (uint160), amount]
        uint[3] memory pubSignals = [
            commitment,
            uint256(uint160(token)),
            amount
        ];
        if (!depositVerifier.verifyProof(proofA, proofB, proofC, pubSignals)) {
            revert InvalidProof();
        }

        // [PR #123 review] Defend against fee-on-transfer / rebasing tokens.
        // The commitment encodes the *parameter* `amount`, so the pool must
        // actually receive exactly that many tokens — otherwise an admin who
        // accidentally whitelists a fee-on-transfer token leaks `fee` per
        // deposit and lets honest depositors slowly drain via overcommitted
        // withdraw amounts. Measuring the balance delta around the transfer
        // turns this silent loss into a hard revert.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert FeeOnTransferTokenUnsupported();

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
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) revert InsufficientPoolBalance();
        // [H-3] Cap fee at MAX_FEE_BPS of pool balance to prevent drain
        if (amount > balance * MAX_FEE_BPS / 10_000) revert FeeExceedsMax();
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
    ) external nonReentrant notSanctioned(msg.sender) notSanctioned(recipient) {
        if (paused) revert ContractPaused();
        _processWithdraw(proofA, proofB, proofC, root, nullifierHash, newCommitment, token, amount, recipient, relayer);
    }

    /// @notice Withdraw on behalf of PrivateSettlement (for scatterDirect).
    /// @dev Only callable by the authorized PrivateSettlement contract.
    ///      Intentionally skips paused check — settlement flows must complete once started.
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
        _processWithdraw(proofA, proofB, proofC, root, nullifierHash, newCommitment, token, amount, recipient, relayer);
    }

    /// @dev Shared withdraw logic: verify proof, mark nullifier, insert change, transfer tokens.
    function _processWithdraw(
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
    ) private {
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
