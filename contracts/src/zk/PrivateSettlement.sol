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
import {IBatchAuthorizeVerifier} from "./IBatchAuthorizeVerifier.sol";
import {IWETH} from "../interfaces/IWETH.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {RelayerRegistry} from "../RelayerRegistry.sol";
import {FeeVault} from "../FeeVault.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";

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
    error ZeroSellAmount();
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
    // ─── settleWithDex errors ──
    error DexRouterNotWhitelisted();
    error DexCallReverted();
    error DexOutputInsufficient(uint256 actual, uint256 required);
    error DexPlatformFeeTooHigh();
    error AddressSanctioned();

    uint256 public constant MAX_DEX_PLATFORM_FEE_BPS = 500; // 5%

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
    event BatchAuthorizeVerifierUpdated(address oldVerifier, address newVerifier);

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
    /// @notice Emitted by `settleWithDex` when a user swaps via an external DEX.
    event SettledWithDex(
        bytes32 indexed nullifier,
        bytes32 indexed claimsRoot,
        address sellToken,
        address buyToken,
        uint128 sellAmount,
        uint256 amountOut,
        uint96  totalLocked,
        address indexed submitter
    );

    event DexRouterWhitelistUpdated(address indexed router, bool allowed);
    event DexPlatformFeeUpdated(uint256 oldBps, uint256 newBps);
    /// @notice Emitted when platform fee is collected from a settleWithDex trade.
    ///         Distinguishes DEX platform fees from relayer fees (FeeClaimed)
    ///         and surplus (SettledWithDex.amountOut − totalLocked).
    event DexPlatformFeeCollected(
        bytes32 indexed nullifier,
        address indexed token,
        uint256 amount,
        address treasury
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
    /// @notice Optional batched verifier for `settleAuth`. When set, `settleAuth`
    ///         uses a single 5-pairing batch check instead of 2× separate verifications,
    ///         saving ~70-100K gas per settlement (3 fewer pairings minus extra EC ops).
    ///         Pass `address(0)` to use separate verifications.
    ///         NOTE: `authorizeVerifier` must still be set — this is an optimization overlay,
    ///         not a replacement. The fallback path uses `authorizeVerifier` directly.
    IBatchAuthorizeVerifier public batchAuthorizeVerifier;
    /// @notice Whitelisted DEX routers for `settleWithDex`.
    ///         Supports any DEX (Uniswap, 1inch, Curve, PancakeSwap, etc.).
    ///         Each router must be explicitly whitelisted by the owner.
    mapping(address => bool) public whitelistedDexRouters;

    /// @notice Platform fee for settleWithDex (in basis points).
    ///         Deducted from sellAmount before the DEX swap. Sent to FeeVault treasury.
    ///         Similar to Tangem/MetaMask swap fee model. 0 = no fee. Max 500 (5%).
    uint256 public dexPlatformFeeBps;

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

    /// @notice Optional sanctions list. If set, sanctioned addresses cannot claim or settle.
    ISanctionsList public sanctionsList;

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

    /// @notice Set (or replace) the optional BatchAuthorizeVerifier.
    ///         When set, `settleAuth` uses batched 5-pairing verification (~70-100K gas savings).
    ///         Pass `address(0)` to fall back to separate 2× verifications.
    ///         Requires `authorizeVerifier` to also be set (this is an optimization overlay).
    function setBatchAuthorizeVerifier(address _verifier) external onlyOwner {
        if (_verifier != address(0) && _verifier.code.length == 0) revert NotAContract();
        emit BatchAuthorizeVerifierUpdated(address(batchAuthorizeVerifier), _verifier);
        batchAuthorizeVerifier = IBatchAuthorizeVerifier(_verifier);
    }

    /// @notice Whitelist or revoke a DEX router for `settleWithDex`.
    ///         Supports any DEX: Uniswap V3, 1inch, Curve, PancakeSwap, etc.
    function setDexRouterWhitelist(address _router, bool _allowed) external onlyOwner {
        if (_router == address(0)) revert ZeroAddress();
        if (_allowed && _router.code.length == 0) revert NotAContract();
        whitelistedDexRouters[_router] = _allowed;
        emit DexRouterWhitelistUpdated(_router, _allowed);
    }

    /// @notice Set platform fee for settleWithDex (in bps). Max 500 (5%).
    error FeeVaultRequired();

    function setDexPlatformFee(uint256 _bps) external onlyOwner {
        if (_bps > MAX_DEX_PLATFORM_FEE_BPS) revert DexPlatformFeeTooHigh();
        if (_bps > 0 && address(feeVault) == address(0)) revert FeeVaultRequired();
        emit DexPlatformFeeUpdated(dexPlatformFeeBps, _bps);
        dexPlatformFeeBps = _bps;
    }

    event SanctionsListUpdated(address indexed oldList, address indexed newList);

    /// @notice Set the sanctions list. Pass address(0) to disable sanctions checking.
    function setSanctionsList(address _list) external onlyOwner {
        if (_list != address(0) && _list.code.length == 0) revert NotAContract();
        emit SanctionsListUpdated(address(sanctionsList), _list);
        sanctionsList = ISanctionsList(_list);
    }

    /// @dev Revert if address is sanctioned.
    function _requireNotSanctioned(address addr) internal view {
        ISanctionsList _list = sanctionsList;
        if (address(_list) != address(0) && _list.isSanctioned(addr)) revert AddressSanctioned();
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
        _requireNotSanctioned(msg.sender);
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
        // 15 public signals (matching authorize.circom output + main block ordering)
        // [0] pubKeyBind is a circuit output = Poseidon(pubKeyAx, pubKeyAy, nullifier)
        // [1..14] are public inputs in the order declared in component main { public [...] }
        bytes32 pubKeyBind;  // Poseidon(pubKeyAx, pubKeyAy, nullifier) — compliance binding
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
        _requireNotSanctioned(msg.sender);
        if (address(authorizeVerifier) == address(0)) revert AuthorizeVerifierNotSet();

        // 2. Non-zero amounts — prevent empty settlements that bloat state
        if (p.maker.sellAmount == 0 || p.taker.sellAmount == 0) revert ZeroSellAmount();

        // 3. Token whitelist (both sell tokens — i.e. tokens that will be
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

        // 10. Verify both Groth16 proofs.
        //     When batchAuthorizeVerifier is set, uses a single 5-pairing batch
        //     check (~70-100K gas savings). Otherwise falls back to 2× separate.
        uint[15] memory makerSignals = _packAuthSignals(p.maker);
        uint[15] memory takerSignals = _packAuthSignals(p.taker);

        if (address(batchAuthorizeVerifier) != address(0)) {
            if (!batchAuthorizeVerifier.verifyBatchProof(
                p.maker.proofA, p.maker.proofB, p.maker.proofC, makerSignals,
                p.taker.proofA, p.taker.proofB, p.taker.proofC, takerSignals
            )) {
                revert InvalidProof();
            }
        } else {
            if (!authorizeVerifier.verifyProof(p.maker.proofA, p.maker.proofB, p.maker.proofC, makerSignals)) {
                revert InvalidProof();
            }
            if (!authorizeVerifier.verifyProof(p.taker.proofA, p.taker.proofB, p.taker.proofC, takerSignals)) {
                revert InvalidProof();
            }
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

    /// @dev Pack an `AuthorizeProof` into the 15-element public-signal array
    ///      that `authorize.circom`'s verifier expects.
    ///      Signal ordering: [0] = pubKeyBind (output), [1..14] = public inputs.
    function _packAuthSignals(AuthorizeProof calldata ap) internal pure returns (uint[15] memory signals) {
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

    // ─── settleWithDex (single-party DEX swap, permissionless) ────
    //
    // Allows a user to trade directly against any whitelisted external DEX
    // (Uniswap, 1inch, Curve, PancakeSwap, etc.) without needing a counterparty
    // or relayer. The user generates a single authorize.circom proof proving
    // commitment ownership + trade intent, then submits it along with
    // DEX-specific swap parameters.
    //
    // Flow:
    //   1. Verify authorize proof (single, not paired)
    //   2. Burn nullifiers, insert residual commitment
    //   3. Extract sellToken from pool
    //   4. Swap via whitelisted DEX router: sellToken → buyToken
    //   5. Register claims group for buyToken output
    //   6. Surplus (amountOut − totalLocked) → protocol treasury

    struct SettleDexParams {
        AuthorizeProof proof;
        address dexRouter;    // any whitelisted DEX router (Uniswap, 1inch, Curve, etc.)
        bytes   dexCalldata;  // encoded swap call for the specific DEX
    }

    /// @notice Execute a private settlement via any whitelisted external DEX.
    ///         The user generates a single authorize.circom proof and swaps
    ///         their escrowed tokens on-chain through any supported DEX router.
    ///         No counterparty needed — permissionless market order.
    ///
    /// @dev    The contract is DEX-agnostic: it approves `dexRouter` for
    ///         `sellAmount`, forwards `dexCalldata` as-is, then checks
    ///         that at least `totalLocked` of `buyToken` was received.
    ///         The frontend constructs the appropriate calldata for the
    ///         chosen DEX (e.g. Uniswap exactInputSingle, 1inch swap, etc.).
    function settleWithDex(SettleDexParams calldata p) external nonReentrant {
        if (paused) revert ContractPaused();
        _requireNotSanctioned(msg.sender);
        if (address(authorizeVerifier) == address(0)) revert AuthorizeVerifierNotSet();
        if (!whitelistedDexRouters[p.dexRouter]) revert DexRouterNotWhitelisted();

        AuthorizeProof calldata proof = p.proof;

        // 1. Relayer binding — msg.sender must match the relayer in the proof.
        //    For permissionless mode, user sets relayer = own address.
        if (msg.sender != proof.relayer) revert NotMakerOrTakerRelayer();

        // 2. Token whitelist
        if (!whitelistedTokens[proof.sellToken]) revert TokenNotWhitelisted();
        if (!whitelistedTokens[proof.buyToken]) revert TokenNotWhitelisted();

        // 3. Non-zero sell amount
        if (proof.sellAmount == 0) revert ZeroSellAmount();

        // 4. Expiry
        if (block.timestamp > proof.expiry) revert OrderExpired();

        // 5. Nullifier double-spend (escrow + nonce)
        if (proof.nullifier == proof.nonceNullifier) revert NullifierAlreadySpent();
        if (nullifiers[proof.nullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[proof.nonceNullifier]) revert NullifierAlreadySpent();

        // 6. Root recency
        if (!pool.isKnownRoot(proof.commitmentRoot)) revert UnknownRoot();

        // 7. Verify Groth16 proof
        uint[15] memory signals = _packAuthSignals(proof);
        if (!authorizeVerifier.verifyProof(proof.proofA, proof.proofB, proof.proofC, signals)) {
            revert InvalidProof();
        }

        // 8. Relayer registry gating — SKIPPED for settleWithDex.
        //    Market orders are permissionless: the user submits directly
        //    (relayer = self). Requiring relayer registration would defeat
        //    the purpose of permissionless DEX settlement.

        // 9. Mark nullifiers
        nullifiers[proof.nullifier] = true;
        nonceNullifiers[proof.nonceNullifier] = true;

        // 10. Insert residual commitment (change UTXO)
        if (proof.newCommitment != bytes32(0)) {
            pool.insertCommitment(uint256(proof.newCommitment));
        }

        // 11. Transfer sellToken from pool to this contract
        uint256 sellBalBefore = IERC20(proof.sellToken).balanceOf(address(this));
        pool.transferToSettlement(proof.sellToken, proof.sellAmount);

        // 11b. Deduct platform fee from sellAmount before DEX swap.
        //      Fee goes directly to FeeVault treasury (not via deposit/claim)
        //      to avoid double-deduction from the relayer claim flow.
        uint256 swapAmount = proof.sellAmount;
        if (dexPlatformFeeBps > 0) {
            uint256 platformFee = uint256(proof.sellAmount) * dexPlatformFeeBps / FEE_BPS_DENOMINATOR;
            swapAmount = uint256(proof.sellAmount) - platformFee;
            if (platformFee > 0) {
                address _treasury = feeVault.treasury();
                IERC20(proof.sellToken).safeTransfer(_treasury, platformFee);
                emit DexPlatformFeeCollected(proof.nullifier, proof.sellToken, platformFee, _treasury);
            }
        }

        // 12. Execute DEX swap (generic — works with any whitelisted router)
        //     Snapshot buyToken balance before swap to measure actual output.
        uint256 buyBalanceBefore = IERC20(proof.buyToken).balanceOf(address(this));

        IERC20(proof.sellToken).forceApprove(p.dexRouter, swapAmount);
        (bool success,) = p.dexRouter.call(p.dexCalldata);
        if (!success) revert DexCallReverted();
        IERC20(proof.sellToken).forceApprove(p.dexRouter, 0);

        // Return any unspent sellToken to the pool (partial fills by DEX).
        // Skip when sellToken == buyToken to avoid draining the buyToken balance
        // that the amountOut check needs to measure.
        if (proof.sellToken != proof.buyToken) {
            uint256 sellRemaining = IERC20(proof.sellToken).balanceOf(address(this));
            if (sellRemaining > sellBalBefore) {
                IERC20(proof.sellToken).safeTransfer(address(pool), sellRemaining - sellBalBefore);
            }
        }

        uint256 amountOut = IERC20(proof.buyToken).balanceOf(address(this)) - buyBalanceBefore;
        if (amountOut < proof.totalLocked) revert DexOutputInsufficient(amountOut, proof.totalLocked);

        // 13. Register claims group
        if (claimsGroups[proof.claimsRoot].totalLocked != 0) revert ClaimsGroupAlreadyExists();
        claimsGroups[proof.claimsRoot] = ClaimsGroup({
            token: proof.buyToken,
            totalLocked: proof.totalLocked,
            totalClaimed: 0
        });

        // 14. Surplus handling: positive slippage goes directly to FeeVault
        //     treasury (not via deposit/claim, which would deduct platform fee).
        //     If no FeeVault is set, surplus stays in the contract.
        if (amountOut > proof.totalLocked) {
            uint256 surplus = amountOut - proof.totalLocked;
            if (address(feeVault) != address(0)) {
                IERC20(proof.buyToken).safeTransfer(feeVault.treasury(), surplus);
            }
            // else: surplus stays in contract balance (recoverable by owner)
        }

        emit SettledWithDex(
            proof.nullifier,
            proof.claimsRoot,
            proof.sellToken,
            proof.buyToken,
            proof.sellAmount,
            amountOut,
            proof.totalLocked,
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
        _requireNotSanctioned(recipient);

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
