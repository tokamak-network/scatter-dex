// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {CommitmentPool} from "./CommitmentPool.sol";
import {ISettleVerifier} from "./ISettleVerifier.sol";
import {IClaimVerifier} from "./IClaimVerifier.sol";
import {IAuthorizeVerifier} from "./IAuthorizeVerifier.sol";
import {ICancelVerifier} from "./ICancelVerifier.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {RelayerRegistry} from "../RelayerRegistry.sol";
import {FeeVault} from "../FeeVault.sol";

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
    error NotMakerOrTakerRelayer();
    error NotYetReleasable();
    error TokenMismatch();
    error AmountOverflow();
    error OnlyWETH();
    error ClaimsGroupAlreadyExists();
    error DuplicateClaimsRoot();
    error TimestampOutOfRange();
    error NotActiveRelayer();
    // ─── settleAuth (Half-proof) errors ──
    error AuthorizeVerifierNotSet();
    error TokenSidesMismatch();
    error PriceMismatch();
    error ClaimsCapExceeded();
    error FeeExceedsMax();
    error OrderExpired();
    // ─── cancelPrivate (escrow rotation cancel) errors ──
    error CancelVerifierNotSet();

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
    event PausedUpdated(bool paused);
    event RelayerRegistryUpdated(address oldRegistry, address newRegistry);
    event FeeVaultUpdated(address oldVault, address newVault);
    event AuthorizeVerifierUpdated(address oldVerifier, address newVerifier);
    event CancelVerifierUpdated(address oldVerifier, address newVerifier);

    /// @notice Emitted by `cancelPrivate`. Relayers listen for this event
    ///         to detect cancelled orders and remove them from their
    ///         in-memory orderbook. The `escrowNullifier` is indexed so
    ///         relayers can filter by it to find which of their orders
    ///         was cancelled. The `nonceNullifier` identifies the specific
    ///         order nonce that was killed.
    event PrivateCancel(
        bytes32 indexed escrowNullifier,
        bytes32 indexed nonceNullifier,
        bytes32 newCommitment,
        address indexed relayer
    );

    /// @notice Emitted by `settleAuth` (Half-proof). Distinct from
    ///         `PrivateSettled` (which `settlePrivate` emits) so off-chain
    ///         indexers can tell the two settlement paths apart.
    /// @dev    Solidity caps indexed event fields at 3, and the three
    ///         indexing slots are spent on `makerNullifier`, `takerNullifier`,
    ///         and `makerRelayer` (the first two for trade-level lookups,
    ///         the third for "find all settlements where I was the maker
    ///         relayer"). `takerRelayer` is included as a non-indexed field
    ///         — indexers that need "find all settlements where I was the
    ///         taker relayer" can scan and filter post-hoc, or build their
    ///         own secondary index off `submitter` (which is `msg.sender`
    ///         and is therefore one of the two relayers).
    event PrivateSettledAuth(
        bytes32 indexed makerNullifier,
        bytes32 indexed takerNullifier,
        bytes32 claimsRootMaker,
        bytes32 claimsRootTaker,
        address indexed makerRelayer,
        address takerRelayer,
        address submitter,
        uint96 feeTokenMaker,
        uint96 feeTokenTaker
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

    /// @notice Optional relayer registry — if set, only active relayers can settle.
    RelayerRegistry public relayerRegistry;
    /// @notice Optional fee vault — if set, fees go to vault instead of msg.sender.
    FeeVault public feeVault;
    /// @notice Verifier for `circuits/authorize.circom` (Half-proof).
    ///         Must be set via `setAuthorizeVerifier` before `settleAuth` is
    ///         callable. Mutable rather than immutable so existing deployments
    ///         can adopt the Half-proof flow without redeploying the
    ///         settlement contract. Setting back to `address(0)` disables
    ///         `settleAuth` (it reverts with `AuthorizeVerifierNotSet`).
    IAuthorizeVerifier public authorizeVerifier;
    /// @notice Verifier for `circuits/cancel.circom` (escrow rotation cancel).
    ICancelVerifier public cancelVerifier;

    /// @notice Maximum past skew allowed between `currentTimestamp` (set by
    ///         the relayer at proof generation time) and `block.timestamp`.
    ///         60 seconds is plenty for proof-gen + tx-propagation latency
    ///         while keeping the stale-order surface tight (the previous
    ///         300s window let an order that expired up to 5 min ago still
    ///         settle — see PR #125 review). Future drift is forbidden by
    ///         the upper bound in `settlePrivate`.
    uint256 public constant TIMESTAMP_TOLERANCE = 60;

    /// @notice Denominator for fee basis points (1 bps = 1/10000).
    ///         Used by `settleAuth` to bound the relayer-chosen fee against
    ///         each side's circuit-bound `maxFee`. Same value as the bps
    ///         denominator inside `settle.circom` §7 (`fee * 10000` checks).
    uint256 public constant FEE_BPS_DENOMINATOR = 10_000;

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
    function setPaused(bool _paused) external onlyOwner { paused = _paused; emit PausedUpdated(_paused); }
    function setTokenWhitelist(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        whitelistedTokens[token] = allowed;
    }
    error NotAContract();

    /// @notice Set the relayer registry. Pass address(0) to disable relayer gating.
    function setRelayerRegistry(address _registry) external onlyOwner {
        if (_registry != address(0) && _registry.code.length == 0) revert NotAContract();
        emit RelayerRegistryUpdated(address(relayerRegistry), _registry);
        relayerRegistry = RelayerRegistry(payable(_registry));
    }
    /// @notice Set the fee vault. Pass address(0) to send fees directly to relayer (legacy mode).
    function setFeeVault(address _vault) external onlyOwner {
        if (_vault != address(0) && _vault.code.length == 0) revert NotAContract();
        emit FeeVaultUpdated(address(feeVault), _vault);
        feeVault = FeeVault(_vault);
    }

    /// @notice Set (or replace) the AuthorizeVerifier used by `settleAuth`.
    ///         Pass `address(0)` to disable the Half-proof path entirely.
    function setAuthorizeVerifier(address _verifier) external onlyOwner {
        if (_verifier != address(0) && _verifier.code.length == 0) revert NotAContract();
        emit AuthorizeVerifierUpdated(address(authorizeVerifier), _verifier);
        authorizeVerifier = IAuthorizeVerifier(_verifier);
    }

    /// @notice Set (or replace) the CancelVerifier used by `cancelPrivate`.
    function setCancelVerifier(address _verifier) external onlyOwner {
        if (_verifier != address(0) && _verifier.code.length == 0) revert NotAContract();
        emit CancelVerifierUpdated(address(cancelVerifier), _verifier);
        cancelVerifier = ICancelVerifier(_verifier);
    }

    /// @dev Revert if relayer registry is set and caller is not an active relayer.
    modifier onlyRelayer() {
        if (address(relayerRegistry) != address(0)) {
            if (!relayerRegistry.isActiveRelayer(msg.sender)) revert NotActiveRelayer();
        }
        _;
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
        uint96 feeTokenMaker;   // fee in tokenMaker (from taker's sell) → paid to takerRelayer
        uint96 feeTokenTaker;   // fee in tokenTaker (from maker's sell) → paid to makerRelayer
        address makerRelayer;   // relayer that handles maker's order (bound in proof)
        address takerRelayer;   // relayer that handles taker's order (bound in proof)
    }

    /// @notice Execute a private settlement with ZK proof.
    /// Only the maker's or taker's relayer can submit (prevents DoS by unauthorized parties).
    /// Relayer addresses are bound in the ZK proof for trustless fee distribution.
    function settlePrivate(SettleParams calldata p) external nonReentrant {
        // Only the maker's or taker's relayer can submit (prevents DoS by unauthorized parties)
        if (msg.sender != p.makerRelayer && msg.sender != p.takerRelayer) revert NotMakerOrTakerRelayer();
        if (paused) revert ContractPaused();
        if (!whitelistedTokens[p.tokenMaker]) revert TokenNotWhitelisted();
        if (!whitelistedTokens[p.tokenTaker]) revert TokenNotWhitelisted();

        if (nullifiers[p.makerNullifier]) revert NullifierAlreadySpent();
        if (nullifiers[p.takerNullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[p.makerNonceNullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[p.takerNonceNullifier]) revert NullifierAlreadySpent();

        // Verify the caller-provided root is known to the pool (avoids reading stale root)
        if (!pool.isKnownRoot(p.currentRoot)) revert UnknownRoot();

        // [M7] Verify the caller-provided timestamp is *not in the future* and
        //      is within TIMESTAMP_TOLERANCE of block.timestamp.
        //
        //      The previous version allowed `currentTimestamp` to drift up to
        //      TIMESTAMP_TOLERANCE (5 min) into the future, which meant the
        //      circuit's `currentTimestamp <= expiry` check could pass for an
        //      already-expired order whose expiry is up to 5 min in the past.
        //      Tightening this to a one-sided window restores the safety margin
        //      while still tolerating proof generation latency / minor clock
        //      skew between the prover and the chain.
        if (
            p.currentTimestamp > block.timestamp ||
            p.currentTimestamp + TIMESTAMP_TOLERANCE < block.timestamp
        ) revert TimestampOutOfRange();

        uint[18] memory pubSignals = [
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
            p.currentTimestamp,
            uint256(uint160(p.makerRelayer)),  // maker's relayer bound in proof
            uint256(uint160(p.takerRelayer))   // taker's relayer bound in proof
        ];

        if (!settleVerifier.verifyProof(p.proofA, p.proofB, p.proofC, pubSignals)) {
            revert InvalidProof();
        }

        // Verify both relayers are registered (if registry is set)
        if (address(relayerRegistry) != address(0)) {
            if (!relayerRegistry.isActiveRelayer(p.makerRelayer)) revert NotActiveRelayer();
            if (!relayerRegistry.isActiveRelayer(p.takerRelayer)) revert NotActiveRelayer();
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

        // Fee split: each relayer earns the fee paid by THEIR user.
        //
        // Naming convention:
        //   feeTokenMaker = fee denominated in tokenMaker (= taker's sell token)
        //                 = fee deducted from taker's sell → paid by taker → goes to takerRelayer
        //   feeTokenTaker = fee denominated in tokenTaker (= maker's sell token)
        //                 = fee deducted from maker's sell → paid by maker → goes to makerRelayer
        //
        // This looks "crossed" but is correct: the token name indicates denomination, not who pays.
        if (p.feeTokenMaker > 0) _routeFeeFromPoolTo(p.tokenMaker, p.feeTokenMaker, p.takerRelayer);
        if (p.feeTokenTaker > 0) _routeFeeFromPoolTo(p.tokenTaker, p.feeTokenTaker, p.makerRelayer);

        // Prevent duplicate claims roots (unless one side has zero locked — e.g., one-sided settle)
        if (p.claimsRootMaker == p.claimsRootTaker && p.totalLockedMaker > 0 && p.totalLockedTaker > 0) revert DuplicateClaimsRoot();
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

    // ─── settleAuth (Half-proof) ─────────────────────────────────
    //
    // Two `circuits/authorize.circom` proofs (one per party) are matched and
    // submitted together. Each proof carries 14 public signals; this function
    // does the cross-party checks (token, price, claims+fees cap, fee bound)
    // that the per-side circuit cannot prove on its own.
    //
    // Async-root design: each side's `commitmentRoot` is independently
    // validated against `pool.isKnownRoot()` (the existing Tornado-style ring
    // buffer in `IncrementalMerkleTree`). The two roots are NOT required to be
    // equal — see `docs/circuit-split/design.md` §2.3 S1 and §6 for the full
    // rationale. Forcing equality would couple both proofs to the same tree
    // snapshot and collapse the matching window in any active pool.
    //
    // Fee model: each side's `maxFee` (in basis points) is bound into its
    // EdDSA-signed `orderHash` inside the circuit. The relayer chooses the
    // actual fee (`feeTokenMaker` / `feeTokenTaker`) at submission time and
    // this contract enforces the per-side bound:
    //   feeTokenMaker * 10000 ≤ taker.sellAmount * taker.maxFee
    //   feeTokenTaker * 10000 ≤ maker.sellAmount * maker.maxFee
    // The naming convention matches `settlePrivate`: `feeTokenMaker` is
    // denominated in `tokenMaker = maker.buyToken = taker.sellToken` and is
    // paid by the taker → goes to `taker.relayer`. `feeTokenTaker` is
    // denominated in `tokenTaker = taker.buyToken = maker.sellToken` and is
    // paid by the maker → goes to `maker.relayer`.

    /// @notice One side of a Half-proof trade. Mirrors the public-signal
    ///         layout of `circuits/authorize.circom` exactly.
    struct AuthorizeProof {
        uint[2] proofA;
        uint[2][2] proofB;
        uint[2] proofC;
        // 14 public signals (matching authorize.circom main block ordering)
        uint256 commitmentRoot;
        bytes32 nullifier;
        bytes32 nonceNullifier;
        bytes32 newCommitment;
        address sellToken;
        address buyToken;
        uint128 sellAmount; // Circuit enforces ≤ 2^126 − 1 via Num2Bits(126)
        uint128 buyAmount;  // Circuit enforces ≤ 2^126 − 1 via Num2Bits(126)
        uint16  maxFee;     // bps; circuit Num2Bits(16) bound
        uint64  expiry;     // unix seconds
        bytes32 claimsRoot;
        uint96  totalLocked;
        address relayer;
        bytes32 orderHash;
    }

    struct SettleAuthParams {
        AuthorizeProof maker;
        AuthorizeProof taker;
        // Relayer-chosen fees, capped by each side's user-signed maxFee
        uint96 feeTokenMaker;
        uint96 feeTokenTaker;
    }

    /// @notice Execute a Half-proof private settlement. Two independent
    ///         `authorize.circom` proofs (maker + taker) are verified and
    ///         settled atomically. See the comment block above for the
    ///         async-root and fee-bound model.
    function settleAuth(SettleAuthParams calldata p) external nonReentrant {
        // 1. Only the two proof relayers may submit
        if (msg.sender != p.maker.relayer && msg.sender != p.taker.relayer) revert NotMakerOrTakerRelayer();
        if (paused) revert ContractPaused();
        if (address(authorizeVerifier) == address(0)) revert AuthorizeVerifierNotSet();

        // 2. Token whitelist (both sell tokens — i.e. tokens that will be
        //    spent from the pool). buyTokens are checked transitively via the
        //    cross-side equality check below.
        if (!whitelistedTokens[p.maker.sellToken]) revert TokenNotWhitelisted();
        if (!whitelistedTokens[p.taker.sellToken]) revert TokenNotWhitelisted();

        // 3. Cross-side token compatibility (C1 in design.md §2.2)
        if (p.maker.sellToken != p.taker.buyToken) revert TokenSidesMismatch();
        if (p.taker.sellToken != p.maker.buyToken) revert TokenSidesMismatch();

        // 4. Cross-side price compatibility (C2 in design.md §2.2)
        //    maker.sellAmount * taker.sellAmount ≥ maker.buyAmount * taker.buyAmount
        //    Both sellAmount and buyAmount are bound by the circuit to ≤ 2^126
        //    via `Num2Bits(126)`, so each product fits in uint256 with ~4 bits
        //    of slack — see docs/circuit-split/bit-width-audit.md §5 for the
        //    full headroom analysis. Do NOT widen the AuthorizeProof field
        //    types past uint128 without re-running that audit.
        uint256 makerProduct = uint256(p.maker.sellAmount) * uint256(p.taker.sellAmount);
        uint256 takerProduct = uint256(p.maker.buyAmount) * uint256(p.taker.buyAmount);
        if (takerProduct > makerProduct) revert PriceMismatch();

        // 5. Cross-side claims + fees cap (C4 in design.md §2.2)
        //    Each side's totalLocked + the fee paid in that token must not
        //    exceed the counterparty's sellAmount.
        if (uint256(p.maker.totalLocked) + uint256(p.feeTokenMaker) > uint256(p.taker.sellAmount)) {
            revert ClaimsCapExceeded();
        }
        if (uint256(p.taker.totalLocked) + uint256(p.feeTokenTaker) > uint256(p.maker.sellAmount)) {
            revert ClaimsCapExceeded();
        }

        // 6. Fee upper bound: relayer-chosen fees must respect each side's
        //    EdDSA-signed maxFee. (The minimum-receive guarantee
        //    `totalLocked ≥ buyAmount` is already enforced inside
        //    authorize.circom §7 per side, so we don't repeat it here.)
        if (uint256(p.feeTokenMaker) * FEE_BPS_DENOMINATOR > uint256(p.taker.sellAmount) * uint256(p.taker.maxFee)) {
            revert FeeExceedsMax();
        }
        if (uint256(p.feeTokenTaker) * FEE_BPS_DENOMINATOR > uint256(p.maker.sellAmount) * uint256(p.maker.maxFee)) {
            revert FeeExceedsMax();
        }

        // 7. Per-side expiry: each side compares its own expiry against
        //    block.timestamp. Unlike settlePrivate, there is no `currentTimestamp`
        //    public input bound into the proof — the circuit only exposes
        //    `expiry`, and this contract is responsible for the comparison.
        if (block.timestamp > p.maker.expiry) revert OrderExpired();
        if (block.timestamp > p.taker.expiry) revert OrderExpired();

        // 8. Nullifier double-spend (4 nullifiers — escrow + nonce per side)
        //
        // Ordered before the root-recency check because the nullifier path
        // is a flat 4 cold SLOADs (~8.4k gas) whereas pool.isKnownRoot is a
        // linear ring-buffer scan that can hit up to ROOT_HISTORY_SIZE cold
        // SLOADs (~63k gas worst case, with default ROOT_HISTORY_SIZE=30).
        // Replay attempts dominate the reverting-call population, so we
        // pay the cheaper check first and short-circuit before the
        // expensive scan.
        //
        // [SECURITY] The intra-transaction equality checks below are
        // load-bearing. Without them, a malicious caller could submit two
        // authorize.circom proofs against the **same** escrow commitment
        // (same secret + same salt → same nullifier on both sides). The
        // per-mapping `nullifiers[...]` checks would each see "not yet
        // spent" because the nullifier is being processed for the first
        // time in this transaction, and the contract would then drain
        // `2 × totalLocked` of the underlying token from the pool while
        // only one commitment was actually consumed — a pool drain.
        //
        // Token compatibility (`maker.sellToken == taker.buyToken` and
        // vice versa) plus same-secret commitment forces both sides to
        // trade the same token for itself, so both `transferToSettlement`
        // calls in step 14 would withdraw from the same token's pool
        // balance. The nonce-nullifier symmetric variant is closed for
        // the same reason. See the security review on PR #133 (gemini
        // comment 3061594760).
        if (p.maker.nullifier == p.taker.nullifier) revert NullifierAlreadySpent();
        if (p.maker.nonceNullifier == p.taker.nonceNullifier) revert NullifierAlreadySpent();

        if (nullifiers[p.maker.nullifier]) revert NullifierAlreadySpent();
        if (nullifiers[p.taker.nullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[p.maker.nonceNullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[p.taker.nonceNullifier]) revert NullifierAlreadySpent();

        // 9. Per-side root recency — async-root model (see preamble).
        //    Each side's root is independently validated against the
        //    rolling history. Equality is NOT required.
        if (!pool.isKnownRoot(p.maker.commitmentRoot)) revert UnknownRoot();
        if (!pool.isKnownRoot(p.taker.commitmentRoot)) revert UnknownRoot();

        // 10. Verify both Groth16 proofs. The packed signal arrays are
        //     held in memory across the two `verifyProof` calls to avoid
        //     stack-too-deep when both proofs are verified back-to-back.
        uint[14] memory makerSignals = _packAuthSignals(p.maker);
        if (!authorizeVerifier.verifyProof(p.maker.proofA, p.maker.proofB, p.maker.proofC, makerSignals)) {
            revert InvalidProof();
        }
        uint[14] memory takerSignals = _packAuthSignals(p.taker);
        if (!authorizeVerifier.verifyProof(p.taker.proofA, p.taker.proofB, p.taker.proofC, takerSignals)) {
            revert InvalidProof();
        }

        // 11. Relayer registry gating (if configured)
        if (address(relayerRegistry) != address(0)) {
            if (!relayerRegistry.isActiveRelayer(p.maker.relayer)) revert NotActiveRelayer();
            if (!relayerRegistry.isActiveRelayer(p.taker.relayer)) revert NotActiveRelayer();
        }

        // 12. Mark nullifiers
        nullifiers[p.maker.nullifier] = true;
        nullifiers[p.taker.nullifier] = true;
        nonceNullifiers[p.maker.nonceNullifier] = true;
        nonceNullifiers[p.taker.nonceNullifier] = true;

        // 13. Insert residual commitments (skip zero — fully spent UTXOs)
        if (p.maker.newCommitment != bytes32(0)) {
            pool.insertCommitment(uint256(p.maker.newCommitment));
        }
        if (p.taker.newCommitment != bytes32(0)) {
            pool.insertCommitment(uint256(p.taker.newCommitment));
        }

        // 14. Transfer claim totals from pool to settlement contract.
        //     `maker.totalLocked` is denominated in `maker.buyToken` (the
        //     token maker is *receiving*), and is drawn from the pool's
        //     balance of that token (which was funded by the taker's
        //     prior deposit of `taker.sellToken == maker.buyToken`).
        if (p.maker.totalLocked > 0) {
            pool.transferToSettlement(p.maker.buyToken, p.maker.totalLocked);
        }
        if (p.taker.totalLocked > 0) {
            pool.transferToSettlement(p.taker.buyToken, p.taker.totalLocked);
        }

        // 15. Fee routing — same naming as settlePrivate. The fee paid by
        //     each side goes to the *counterparty's* relayer, which is the
        //     trustless fee split established in PR #126 / Phase 3.6.
        if (p.feeTokenMaker > 0) _routeFeeFromPoolTo(p.maker.buyToken, p.feeTokenMaker, p.taker.relayer);
        if (p.feeTokenTaker > 0) _routeFeeFromPoolTo(p.taker.buyToken, p.feeTokenTaker, p.maker.relayer);

        // 16. Register claims groups
        //     The duplicate-claims-root guard is gated on both sides being
        //     non-zero so a one-sided fully-claimed settle (where one side
        //     keeps everything internally) can still settle without colliding.
        if (
            p.maker.claimsRoot == p.taker.claimsRoot &&
            p.maker.totalLocked > 0 &&
            p.taker.totalLocked > 0
        ) revert DuplicateClaimsRoot();

        if (claimsGroups[p.maker.claimsRoot].totalLocked != 0) revert ClaimsGroupAlreadyExists();
        claimsGroups[p.maker.claimsRoot] = ClaimsGroup({
            token: p.maker.buyToken,
            totalLocked: p.maker.totalLocked,
            totalClaimed: 0
        });

        if (claimsGroups[p.taker.claimsRoot].totalLocked != 0) revert ClaimsGroupAlreadyExists();
        claimsGroups[p.taker.claimsRoot] = ClaimsGroup({
            token: p.taker.buyToken,
            totalLocked: p.taker.totalLocked,
            totalClaimed: 0
        });

        emit PrivateSettledAuth(
            p.maker.nullifier,
            p.taker.nullifier,
            p.maker.claimsRoot,
            p.taker.claimsRoot,
            p.maker.relayer,
            p.taker.relayer,
            msg.sender,
            p.feeTokenMaker,
            p.feeTokenTaker
        );
    }

    /// @dev Pack an `AuthorizeProof` into the 14-element public-signal array
    ///      that `authorize.circom`'s verifier expects, in the same order as
    ///      the circuit's `component main { public [...] }` block.
    function _packAuthSignals(AuthorizeProof calldata ap) internal pure returns (uint[14] memory signals) {
        signals[0]  = ap.commitmentRoot;
        signals[1]  = uint256(ap.nullifier);
        signals[2]  = uint256(ap.nonceNullifier);
        signals[3]  = uint256(ap.newCommitment);
        signals[4]  = uint256(uint160(ap.sellToken));
        signals[5]  = uint256(uint160(ap.buyToken));
        signals[6]  = uint256(ap.sellAmount);
        signals[7]  = uint256(ap.buyAmount);
        signals[8]  = uint256(ap.maxFee);
        signals[9]  = uint256(ap.expiry);
        signals[10] = uint256(ap.claimsRoot);
        signals[11] = uint256(ap.totalLocked);
        signals[12] = uint256(uint160(ap.relayer));
        signals[13] = uint256(ap.orderHash);
    }

    // ─── cancelPrivate (escrow rotation cancel) ─────────────────────
    //
    // Atomically cancels a pending authorize order by burning both the
    // escrow nullifier and the nonce nullifier, then inserting a new
    // commitment with the same balance (rotated salt). No tokens move.
    //
    // After this tx mines:
    //   - Any settleAuth using the old escrow nullifier reverts (NullifierAlreadySpent)
    //   - The user has a fresh commitment and can make new orders immediately
    //   - The PrivateCancel event tells relayers which order was cancelled
    //     (relayers listen for the nonceNullifier to remove from orderbook)

    struct CancelParams {
        uint[2] proofA;
        uint[2][2] proofB;
        uint[2] proofC;
        uint256 commitmentRoot;
        bytes32 oldNullifier;
        bytes32 oldNonceNullifier;
        bytes32 newCommitment;
    }

    /// @notice Cancel a pending order via escrow rotation.
    ///         The cancel.circom proof proves the caller owns the commitment
    ///         and signed the cancel with their EdDSA key.
    ///         Anyone can submit — no relayer gating. The proof binds
    ///         msg.sender as the submitter, and the Groth16 verification
    ///         is the access control. The user typically submits directly
    ///         from their own wallet (no relayer needed for cancel).
    function cancelPrivate(CancelParams calldata p) external nonReentrant {
        if (paused) revert ContractPaused();
        if (address(cancelVerifier) == address(0)) revert CancelVerifierNotSet();

        // Cancel MUST produce a new commitment — otherwise the balance
        // is permanently bricked (both nullifiers burnt, no replacement).
        if (p.newCommitment == bytes32(0)) revert ZeroAddress();

        // Nullifier double-spend (before root recency — same gas
        // optimization as settleAuth: flat SLOADs before ring-buffer scan)
        if (nullifiers[p.oldNullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[p.oldNonceNullifier]) revert NullifierAlreadySpent();
        // Intra-tx: escrow and nonce nullifiers must differ (domain-separated
        // by TAG_ESCROW_NULL vs TAG_NONCE_NULL, but belt-and-suspenders)
        if (p.oldNullifier == p.oldNonceNullifier) revert NullifierAlreadySpent();

        // Root recency
        if (!pool.isKnownRoot(p.commitmentRoot)) revert UnknownRoot();

        // Verify cancel proof (5 public signals)
        uint[5] memory pubSignals = [
            p.commitmentRoot,
            uint256(p.oldNullifier),
            uint256(p.oldNonceNullifier),
            uint256(p.newCommitment),
            uint256(uint160(msg.sender))  // relayer = msg.sender (bound in proof)
        ];
        if (!cancelVerifier.verifyProof(p.proofA, p.proofB, p.proofC, pubSignals)) {
            revert InvalidProof();
        }

        // Burn both nullifiers
        nullifiers[p.oldNullifier] = true;
        nonceNullifiers[p.oldNonceNullifier] = true;

        // Insert rotated commitment (same balance, new salt).
        // The zero-check at the top of this function guarantees
        // newCommitment != 0, so this always inserts.
        pool.insertCommitment(uint256(p.newCommitment));

        emit PrivateCancel(
            p.oldNullifier,
            p.oldNonceNullifier,
            p.newCommitment,
            msg.sender
        );
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
    function scatterDirect(ScatterDirectParams calldata p) external onlyRelayer nonReentrant {
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

        // Transfer fee
        if (p.fee > 0) _routeFeeLocal(p.token, p.fee);

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

    // ─── Internal Fee Routing ────────────────────────────────────

    /// @dev Route fee from CommitmentPool to msg.sender via vault (legacy: scatterDirect).
    function _routeFeeFromPool(address token, uint256 amount) internal {
        _routeFeeFromPoolTo(token, amount, msg.sender);
    }

    /// @dev Route fee from CommitmentPool to a specific relayer via vault.
    function _routeFeeFromPoolTo(address token, uint256 amount, address relayer) internal {
        if (address(feeVault) != address(0)) {
            pool.transferFee(address(feeVault), token, amount);
            feeVault.deposit(relayer, token, amount);
        } else {
            pool.transferFee(relayer, token, amount);
        }
    }

    /// @dev Route fee from this contract's balance to vault or relayer.
    function _routeFeeLocal(address token, uint256 amount) internal {
        if (address(feeVault) != address(0)) {
            IERC20(token).safeTransfer(address(feeVault), amount);
            feeVault.deposit(msg.sender, token, amount);
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
    }

    /// @dev Accept ETH only from WETH.withdraw() during claimWithProof().
    receive() external payable {
        if (msg.sender != weth) revert OnlyWETH();
    }

    // Claims are permanently claimable — no expiry or refund mechanism.
    // Claim holders can claim at any time after releaseTime with a valid ZK proof.
}
