// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CommitmentPool} from "./CommitmentPool.sol";
import {IClaimVerifier} from "./IClaimVerifier.sol";
import {IAuthorizeVerifier} from "./IAuthorizeVerifier.sol";
import {ICancelVerifier} from "./ICancelVerifier.sol";
import {IBatchAuthorizeVerifier} from "./IBatchAuthorizeVerifier.sol";
import {IWETH} from "../interfaces/IWETH.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {RelayerRegistry} from "../RelayerRegistry.sol";
import {FeeVault} from "../FeeVault.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {SettleVerifyLib} from "./SettleVerifyLib.sol";

/// @title PrivateSettlement
/// @notice ZK-based private settlement for zkScatter. Matches Half-proof
///         (authorize.circom) orders via `settleAuth`, routes market orders
///         through whitelisted DEXes via `settleWithDex`, and handles
///         same-token scatters via `scatterDirectAuth`. Claims are
///         distributed via `claimWithProof` — a ZK proof of membership in
///         a per-settle `claimsRoot` without revealing which settle.
contract PrivateSettlement is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

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
    error DuplicateClaimsRoot();
    error NotActiveRelayer();
    /// @notice Reverts when `settleAuth` receives a proof for a tier that
    ///         has no verifier configured. Owner must call
    ///         `setAuthorizeVerifier(tier, addr)` for the tier first.
    error TierNotConfigured(uint8 tier);
    error CancelVerifierNotSet();

    // Errors that are actually reverted from SettleVerifyLib but re-declared
    // here to preserve the contract's ABI surface — downstream Solidity code
    // that references `PrivateSettlement.<Name>.selector` keeps working. The
    // selector is computed from the name+arg-types, so the lib's revert and
    // these declarations resolve to the same 4-byte identifier on the wire.
    error ZeroSellAmount();
    error ZeroBuyAmount();
    error TokenSidesMismatch();
    error PriceMismatch();
    error ClaimsCapExceeded();
    error FeeExceedsMax();
    error OrderExpired();
    error SellBuyTokenMismatch();
    error ClaimsGroupAlreadyExists();
    // ─── settleWithDex errors ──
    error DexRouterNotWhitelisted();
    error DexCallReverted();
    error DexOutputInsufficient(uint256 actual, uint256 required);
    error DexPlatformFeeTooHigh();
    error AddressSanctioned();
    error EmptyBatch();
    error BatchTooLarge();
    /// @dev `claimToPool` slice sum did not equal the claim's amount.
    error SumMismatch();
    /// @dev `claimToPool` was called with more than `MAX_CLAIM_TO_POOL_SLICES`
    ///      slices. The cap keeps per-tx gas bounded.
    error TooManySlices();
    /// @dev `claimToPool` slice contained a zero amount, zero commitment,
    ///      or amount exceeding the total claim amount.
    error InvalidSlice();
    /// @dev `claimToPool` stealthSignature did not recover to
    ///      `stealthRecipient`. Indicates either a malformed signature or
    ///      a payload (slices/nullifier/amount/token) that doesn't match
    ///      what the stealth privkey holder authorized.
    error InvalidStealthSignature();

    uint256 public constant MAX_DEX_PLATFORM_FEE_BPS = 500; // 5%

    /// @notice Max number of claims per `claimWithProofBatch` call. Limits
    ///         worst-case gas per tx (~300K × N) so a batch cannot exceed the
    ///         block gas limit. Frontends should chunk larger sets.
    uint256 public constant MAX_CLAIM_BATCH_SIZE = 20;

    /// @notice Max slices per `claimToPool` call. Each slice runs a full
    ///         deposit ZK verification (~300k) + transferFrom + Merkle
    ///         insert (~50k); 8 stays comfortably under L1 block gas.
    ///         Anonymity-set value past 4–8 hits diminishing returns
    ///         anyway, so 8 is a comfortable ceiling.
    uint256 public constant MAX_CLAIM_TO_POOL_SLICES = 8;

    /// @notice EIP-712 typehash for `ClaimToPoolAuth`. The stealth
    ///         privkey holder signs this struct to authorize a claim →
    ///         pool redirect with a specific slice layout. `slicesHash`
    ///         is `keccak256(abi.encode(slices))` so substituting any
    ///         field of any slice invalidates the signature.
    bytes32 private constant CLAIM_TO_POOL_AUTH_TYPEHASH =
        keccak256(
            "ClaimToPoolAuth(bytes32 claimNullifier,uint256 amount,address token,bytes32 slicesHash)"
        );

    /// @dev EIP-712 domain typehash. Inlined (rather than inheriting
    ///      OZ's `EIP712` base) so we don't pay 2 storage slots for
    ///      its name/version cache — a contract this size benefits
    ///      more from byte-stable storage layout than from the ~10k
    ///      gas the cache saves on `_hashTypedDataV4` once per claim.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_HASHED_NAME = keccak256(bytes("PrivateSettlement"));
    bytes32 private constant _EIP712_HASHED_VERSION = keccak256(bytes("1"));

    // ─── Events ──────────────────────────────────────────────────
    event PrivateClaim(
        bytes32 indexed claimsRoot,
        bytes32 indexed nullifier,
        address indexed recipient,
        address token,
        uint256 amount
    );
    /// @notice Emitted by `claimToPool`. The per-slice commitments are not
    ///         included here — the pool's existing `CommitmentInserted`
    ///         events (one per slice via `pool.deposit`) already carry
    ///         `(commitment, leafIndex, timestamp)`.
    event PrivateClaimToPool(
        bytes32 indexed claimsRoot,
        bytes32 indexed nullifier,
        address indexed stealthRecipient,
        address token,
        uint256 amount,
        uint256 sliceCount
    );
    event PausedUpdated(bool paused);
    event RelayerRegistryUpdated(address oldRegistry, address newRegistry);
    event FeeVaultUpdated(address oldVault, address newVault);
    event AuthorizeVerifierUpdated(uint8 indexed tier, address oldVerifier, address newVerifier);
    event CancelVerifierUpdated(address oldVerifier, address newVerifier);
    event ClaimVerifierUpdated(uint8 indexed tier, address oldVerifier, address newVerifier);
    event BatchAuthorizeVerifierUpdated(uint8 indexed tier, address oldVerifier, address newVerifier);

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

    /// @notice Emitted by `settleAuth` (Half-proof).
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
        uint128 totalLocked,
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
        address vault
    );

    /// @notice Emitted when positive slippage from settleWithDex is credited
    ///         to FeeVault.platformRevenue as market-order surplus.
    event DexSurplusCollected(
        bytes32 indexed nullifier,
        address indexed token,
        uint256 amount,
        address vault
    );

    // ─── State ───────────────────────────────────────────────────
    // ClaimsGroup struct lives in SettleVerifyLib (shared with the library).
    CommitmentPool public immutable pool;
    /// @notice Verifier registry for `circuits/claim.circom`, keyed by
    ///         the originating settlement's tier. Each tier has its
    ///         own `claimsTreeDepth` (4 / 6 / 7) so a single claim
    ///         verifier cannot serve all tiers. Constructor seeds
    ///         tier 16; new tiers register via `setClaimVerifier`.
    mapping(uint8 => IClaimVerifier) public claimVerifierByTier;
    address public immutable weth;

    /// @notice Optional relayer registry — if set, only active relayers can settle.
    RelayerRegistry public relayerRegistry;
    /// @notice Optional fee vault — if set, fees go to vault instead of msg.sender.
    FeeVault public feeVault;
    /// @notice Verifier registry for `circuits/authorize.circom`, keyed by
    ///         circuit tier (= max claims per side). Tier 16 is the only
    ///         circuit live today; the registry shape lets future tiers
    ///         (64 / 128) attach without redeploying or rewiring this
    ///         settlement contract — `setAuthorizeVerifier(tier, addr)` is
    ///         the only owner action needed. Setting back to `address(0)`
    ///         disables `settleAuth` for that tier (reverts with
    ///         `TierNotConfigured`).
    mapping(uint8 => IAuthorizeVerifier) public authorizeVerifierByTier;
    /// @notice Verifier for `circuits/cancel.circom` (escrow rotation cancel).
    ICancelVerifier public cancelVerifier;
    /// @notice Optional batched verifier registry, keyed by tier. When the
    ///         maker and taker proofs share a tier and that tier has a
    ///         batched verifier set, `settleAuth` uses a single 5-pairing
    ///         batch check instead of 2× separate verifications (~70-100K
    ///         gas savings). Mixed-tier settlements always fall back to
    ///         per-side verification.
    mapping(uint8 => IBatchAuthorizeVerifier) public batchAuthorizeVerifierByTier;
    /// @notice Whitelisted DEX routers for `settleWithDex`.
    ///         Supports any DEX (Uniswap, 1inch, Curve, PancakeSwap, etc.).
    ///         Each router must be explicitly whitelisted by the owner.
    mapping(address => bool) public whitelistedDexRouters;

    /// @notice Platform fee for settleWithDex (in basis points).
    ///         Deducted from sellAmount before the DEX swap. Sent to FeeVault treasury.
    ///         Similar to Tangem/MetaMask swap fee model. 0 = no fee. Max 500 (5%).
    uint256 public dexPlatformFeeBps;

    /// @notice Denominator for fee basis points (1 bps = 1/10000).
    ///         Used by `settleAuth` to bound the relayer-chosen fee against
    ///         each side's circuit-bound `maxFee`.
    uint256 public constant FEE_BPS_DENOMINATOR = 10_000;

    bool public paused;

    mapping(bytes32 => bool) public nullifiers;       // escrow nullifiers
    mapping(bytes32 => bool) public nonceNullifiers;   // nonce nullifiers
    mapping(bytes32 => bool) public claimNullifiers;   // claim nullifiers
    mapping(bytes32 => SettleVerifyLib.ClaimsGroup) public claimsGroups;
    mapping(address => bool) public whitelistedTokens;

    /// @notice Optional sanctions list. If set, sanctioned addresses cannot claim or settle.
    ISanctionsList public sanctionsList;

    // ─── Constructor ─────────────────────────────────────────────
    constructor(
        address _pool,
        address _claimVerifier,
        address _weth
    ) Ownable(msg.sender) {
        if (_pool == address(0) || _claimVerifier == address(0) || _weth == address(0))
            revert ZeroAddress();
        pool = CommitmentPool(_pool);
        // Seed the claim-verifier registry with tier 16 — the only live
        // circuit today. New tiers attach post-deploy via setClaimVerifier.
        claimVerifierByTier[16] = IClaimVerifier(_claimVerifier);
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
        // Reset dex platform fee if vault is being removed (prevents stuck fee config)
        if (_vault == address(0) && dexPlatformFeeBps > 0) {
            emit DexPlatformFeeUpdated(dexPlatformFeeBps, 0);
            dexPlatformFeeBps = 0;
        }
        emit FeeVaultUpdated(address(feeVault), _vault);
        feeVault = FeeVault(_vault);
    }

    /// @notice Register (or replace) the AuthorizeVerifier for a tier.
    ///         `tier` is the circuit's max-claims-per-side (16, 64, 128 …).
    ///         Pass `address(0)` to disable `settleAuth` for that tier.
    function setAuthorizeVerifier(uint8 tier, address _verifier) external onlyOwner {
        if (_verifier != address(0) && _verifier.code.length == 0) revert NotAContract();
        emit AuthorizeVerifierUpdated(tier, address(authorizeVerifierByTier[tier]), _verifier);
        authorizeVerifierByTier[tier] = IAuthorizeVerifier(_verifier);
    }

    /// @notice Set (or replace) the CancelVerifier used by `cancelPrivate`.
    function setCancelVerifier(address _verifier) external onlyOwner {
        if (_verifier != address(0) && _verifier.code.length == 0) revert NotAContract();
        emit CancelVerifierUpdated(address(cancelVerifier), _verifier);
        cancelVerifier = ICancelVerifier(_verifier);
    }

    /// @notice Register (or replace) the ClaimVerifier for a tier.
    ///         `tier` is the originating settlement's tier (= claims
    ///         tree depth → 16/64/128). Pass `address(0)` to disable
    ///         claims for that tier — recipients then revert with
    ///         `TierNotConfigured(tier)` until a verifier registers.
    function setClaimVerifier(uint8 tier, address _verifier) external onlyOwner {
        if (_verifier != address(0) && _verifier.code.length == 0) revert NotAContract();
        emit ClaimVerifierUpdated(tier, address(claimVerifierByTier[tier]), _verifier);
        claimVerifierByTier[tier] = IClaimVerifier(_verifier);
    }

    /// @notice Register (or replace) the optional BatchAuthorizeVerifier
    ///         for a tier. Only used when both maker and taker proofs in a
    ///         settlement share that tier; mixed-tier settlements always
    ///         fall back to per-side verification. `address(0)` disables
    ///         the optimisation for that tier.
    function setBatchAuthorizeVerifier(uint8 tier, address _verifier) external onlyOwner {
        if (_verifier != address(0) && _verifier.code.length == 0) revert NotAContract();
        emit BatchAuthorizeVerifierUpdated(tier, address(batchAuthorizeVerifierByTier[tier]), _verifier);
        batchAuthorizeVerifierByTier[tier] = IBatchAuthorizeVerifier(_verifier);
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
        RelayerRegistry _registry = relayerRegistry;
        if (address(_registry) != address(0)) {
            if (!_registry.isActiveRelayer(msg.sender)) revert NotActiveRelayer();
        }
        _;
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
    // this contract enforces the per-side bound (each side's fee capped
    // against that side's OWN `buyAmount`, matching the 2026-04-14
    // fee-semantics redesign):
    //   feeTokenMaker * 10000 ≤ maker.buyAmount * maker.maxFee
    //   feeTokenTaker * 10000 ≤ taker.buyAmount * taker.maxFee
    // Naming: `feeTokenMaker` is denominated in
    // `tokenMaker = maker.buyToken = taker.sellToken` — it is the
    // maker-side fee (drawn from what the maker receives) and goes to
    // `maker.relayer`. `feeTokenTaker` is denominated in
    // `tokenTaker = taker.buyToken = maker.sellToken` — it is the
    // taker-side fee and goes to `taker.relayer`.

    struct SettleAuthParams {
        SettleVerifyLib.AuthorizeProof maker;
        SettleVerifyLib.AuthorizeProof taker;
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
        // Resolve the verifier for each side's tier. Mixed tiers are allowed
        // (e.g. maker tier-16 ↔ taker tier-64) — the registry is per-tier so
        // each side gets the right Groth16 verifier independently. Today
        // only tier 16 is wired, but the lookup is the same shape that will
        // serve tier 64 / 128 once those circuits ship. Same-tier
        // settlements (the only path until tier 64 ships) skip the second
        // SLOAD by reusing the maker's verifier.
        IAuthorizeVerifier _makerVerifier = authorizeVerifierByTier[p.maker.tier];
        if (address(_makerVerifier) == address(0)) revert TierNotConfigured(p.maker.tier);
        IAuthorizeVerifier _takerVerifier = p.maker.tier == p.taker.tier
            ? _makerVerifier
            : authorizeVerifierByTier[p.taker.tier];
        if (address(_takerVerifier) == address(0)) revert TierNotConfigured(p.taker.tier);

        // Cross-side invariants: non-zero amounts, whitelist, token
        // compatibility (C1), price (C2), claims+fee cap (C4), fee
        // upper bound, and per-side expiry.
        SettleVerifyLib.validateCrossSide(
            p.maker, p.taker, p.feeTokenMaker, p.feeTokenTaker, whitelistedTokens
        );

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
        //     The batched 5-pairing optimisation only applies when both
        //     sides share a tier (the batch verifier is itself tier-specific
        //     because the IC base points differ per circuit). Mixed-tier
        //     settlements always fall back to per-side verification.
        uint[15] memory makerSignals = SettleVerifyLib.packAuthSignals(p.maker);
        uint[15] memory takerSignals = SettleVerifyLib.packAuthSignals(p.taker);

        IBatchAuthorizeVerifier _batchVerifier = p.maker.tier == p.taker.tier
            ? batchAuthorizeVerifierByTier[p.maker.tier]
            : IBatchAuthorizeVerifier(address(0));
        if (address(_batchVerifier) != address(0)) {
            if (!_batchVerifier.verifyBatchProof(
                p.maker.proofA, p.maker.proofB, p.maker.proofC, makerSignals,
                p.taker.proofA, p.taker.proofB, p.taker.proofC, takerSignals
            )) {
                revert InvalidProof();
            }
        } else {
            if (!_makerVerifier.verifyProof(p.maker.proofA, p.maker.proofB, p.maker.proofC, makerSignals)) {
                revert InvalidProof();
            }
            if (!_takerVerifier.verifyProof(p.taker.proofA, p.taker.proofB, p.taker.proofC, takerSignals)) {
                revert InvalidProof();
            }
        }

        // 11. Relayer registry gating (if configured)
        RelayerRegistry _registry = relayerRegistry;
        if (address(_registry) != address(0)) {
            if (!_registry.isActiveRelayer(p.maker.relayer)) revert NotActiveRelayer();
            if (!_registry.isActiveRelayer(p.taker.relayer)) revert NotActiveRelayer();
        }

        // 12. Mark nullifiers
        nullifiers[p.maker.nullifier] = true;
        nullifiers[p.taker.nullifier] = true;
        nonceNullifiers[p.maker.nonceNullifier] = true;
        nonceNullifiers[p.taker.nonceNullifier] = true;

        // 13. Insert residual commitments (skip zero — fully spent UTXOs)
        SettleVerifyLib.maybeInsertCommitment(pool, p.maker.newCommitment);
        SettleVerifyLib.maybeInsertCommitment(pool, p.taker.newCommitment);

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

        // 15. Fee routing — each user's signed maxFee caps the fee drawn
        //     from their own buyAmount, and that fee goes to the relayer
        //     that holds their order.
        if (p.feeTokenMaker > 0) _routeFeeFromPoolTo(p.maker.buyToken, p.feeTokenMaker, p.maker.relayer);
        if (p.feeTokenTaker > 0) _routeFeeFromPoolTo(p.taker.buyToken, p.feeTokenTaker, p.taker.relayer);

        // 16. Register claims groups. Duplicate-root guard is gated on both
        //     sides being non-zero so one-sided fully-claimed settles still fit.
        SettleVerifyLib.requireDistinctClaimsRoots(
            p.maker.claimsRoot, p.taker.claimsRoot, p.maker.totalLocked, p.taker.totalLocked
        );
        SettleVerifyLib.registerClaimsGroup(claimsGroups, p.maker.claimsRoot, p.maker.buyToken, p.maker.totalLocked, p.maker.tier);
        SettleVerifyLib.registerClaimsGroup(claimsGroups, p.taker.claimsRoot, p.taker.buyToken, p.taker.totalLocked, p.taker.tier);

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
        SettleVerifyLib.AuthorizeProof proof;
        address dexRouter;    // any whitelisted DEX router (Uniswap, 1inch, Curve, etc.)
        bytes   dexCalldata;  // encoded swap call for the specific DEX
        uint256 deadline;     // [C-1] tx must be mined before this timestamp
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
    error DeadlineExpired();

    function settleWithDex(SettleDexParams calldata p) external nonReentrant {
        if (paused) revert ContractPaused();
        _requireNotSanctioned(msg.sender);
        // Cache storage refs used multiple times in this function so each is
        // loaded once instead of at every reference.
        SettleVerifyLib.AuthorizeProof calldata proof = p.proof;
        IAuthorizeVerifier _verifier = authorizeVerifierByTier[proof.tier];
        FeeVault _feeVault = feeVault;
        if (address(_verifier) == address(0)) revert TierNotConfigured(proof.tier);
        if (!whitelistedDexRouters[p.dexRouter]) revert DexRouterNotWhitelisted();

        SettleVerifyLib.validateDexProof(proof, msg.sender, p.deadline, whitelistedTokens);

        // Nullifier double-spend (storage)
        if (nullifiers[proof.nullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[proof.nonceNullifier]) revert NullifierAlreadySpent();

        // 6. Root recency
        if (!pool.isKnownRoot(proof.commitmentRoot)) revert UnknownRoot();

        // 7. Verify Groth16 proof
        uint[15] memory signals = SettleVerifyLib.packAuthSignals(proof);
        if (!_verifier.verifyProof(proof.proofA, proof.proofB, proof.proofC, signals)) {
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
        SettleVerifyLib.maybeInsertCommitment(pool, proof.newCommitment);

        // 11. Transfer sellToken from pool to this contract
        uint256 sellBalBefore = IERC20(proof.sellToken).balanceOf(address(this));
        pool.transferToSettlement(proof.sellToken, proof.sellAmount);

        // 11b. Deduct platform fee from sellAmount before DEX swap.
        //      Fee is routed through FeeVault.platformRevenue so it's tracked
        //      independently from relayer balances; treasury pulls via
        //      withdrawPlatformRevenue(token). Kept out of the relayer deposit
        //      ledger on purpose — otherwise platform fee would be deducted
        //      twice (once here, again on relayer claim).
        uint256 sellAmountU256 = uint256(proof.sellAmount);
        uint256 swapAmount = sellAmountU256;
        {
            uint256 feeBps = dexPlatformFeeBps;
            if (feeBps > 0) {
                uint256 platformFee = sellAmountU256 * feeBps / FEE_BPS_DENOMINATOR;
                swapAmount = sellAmountU256 - platformFee;
                if (platformFee > 0 && address(_feeVault) != address(0)) {
                    IERC20(proof.sellToken).safeTransfer(address(_feeVault), platformFee);
                    _feeVault.accrueDexFee(proof.sellToken, platformFee);
                    emit DexPlatformFeeCollected(proof.nullifier, proof.sellToken, platformFee, address(_feeVault));
                }
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
        SettleVerifyLib.registerClaimsGroup(claimsGroups, proof.claimsRoot, proof.buyToken, proof.totalLocked, proof.tier);

        // 14. Surplus handling: positive slippage is transferred to FeeVault
        //     and credited to FeeVault.platformRevenue (independent of
        //     relayer balances). Treasury later withdraws it via
        //     withdrawPlatformRevenue(token). When no FeeVault is set,
        //     surplus stays in the contract (owner recovery).
        if (amountOut > proof.totalLocked) {
            uint256 surplus = amountOut - proof.totalLocked;
            if (address(_feeVault) != address(0)) {
                IERC20(proof.buyToken).safeTransfer(address(_feeVault), surplus);
                _feeVault.accrueDexSurplus(proof.buyToken, surplus);
                emit DexSurplusCollected(proof.nullifier, proof.buyToken, surplus, address(_feeVault));
            }
        }

        _emitSettledWithDex(proof, amountOut);
    }

    /// @dev Helper extracted from {settleWithDex} to keep the parent
    ///      function under solc's stack-depth limit (the `tier` field
    ///      added to AuthorizeProof bumped the calldata-decode pressure
    ///      enough to push the emit-site over the 16-slot ceiling
    ///      without via_ir). The split is purely for compilation; the
    ///      event semantics are unchanged.
    function _emitSettledWithDex(
        SettleVerifyLib.AuthorizeProof calldata proof,
        uint256 amountOut
    ) internal {
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
        uint128 totalLocked;         // sum of claim amounts; matches circuit Num2Bits(128)
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

        // Register claims group (prevent overwriting existing group).
        // scatterDirect uses a withdraw proof (no authorize tier on the
        // params), so we record tier 16 — the only depth the live claim
        // verifier handles. Future tier-aware scatter variants would
        // thread the tier through ScatterDirectParams.
        SettleVerifyLib.registerClaimsGroup(claimsGroups, p.claimsRoot, p.token, p.totalLocked, 16);

        // Transfer fee
        if (p.fee > 0) _routeFeeLocal(p.token, p.fee);

        emit ScatterDirect(p.nullifier, p.claimsRoot, msg.sender, p.fee);
    }

    // ─── Scatter Direct Auth (single-party, same-token via authorize proof) ──

    struct ScatterDirectAuthParams {
        SettleVerifyLib.AuthorizeProof proof;
        uint96 fee;              // relayer-chosen fee in token units
    }

    event ScatterDirectAuthSettled(
        bytes32 indexed nullifier,
        bytes32 indexed nonceNullifier,
        bytes32 claimsRoot,
        address indexed relayer,
        uint96 fee
    );

    /// @notice Single-party scatter using an authorize.circom proof (half-proof model).
    ///         The user generates the proof client-side — the relayer never holds witness data.
    ///         Requires sellToken == buyToken (same-token scatter invariant).
    function scatterDirectAuth(ScatterDirectAuthParams calldata p) external nonReentrant {
        SettleVerifyLib.AuthorizeProof calldata ap = p.proof;

        // Order-of-checks preserved from before: cheap calldata compare gates
        // state reads, and relayer registry is checked before proof verify.
        if (paused) revert ContractPaused();
        IAuthorizeVerifier _verifier = authorizeVerifierByTier[ap.tier];
        if (address(_verifier) == address(0)) revert TierNotConfigured(ap.tier);
        _requireNotSanctioned(msg.sender);

        // Relayer binding, same-token invariant, whitelist, non-zero
        // amounts, fee cap, claims+fee cap, expiry.
        SettleVerifyLib.validateScatterAuth(ap, msg.sender, p.fee, whitelistedTokens);

        // Relayer registry (before expensive proof verification — saves ~200K gas on revert)
        RelayerRegistry _registry = relayerRegistry;
        if (address(_registry) != address(0)) {
            if (!_registry.isActiveRelayer(ap.relayer)) revert NotActiveRelayer();
        }

        // 8. Nullifier double-spend (escrow + nonce — 2 cold SLOADs)
        if (nullifiers[ap.nullifier]) revert NullifierAlreadySpent();
        if (nonceNullifiers[ap.nonceNullifier]) revert NullifierAlreadySpent();

        // Root recency (ring-buffer scan — up to 30 SLOADs)
        if (!pool.isKnownRoot(ap.commitmentRoot)) revert UnknownRoot();

        // 11. Verify Groth16 proof (~200K gas — most expensive check, last)
        uint[15] memory signals = SettleVerifyLib.packAuthSignals(ap);
        if (!_verifier.verifyProof(ap.proofA, ap.proofB, ap.proofC, signals)) {
            revert InvalidProof();
        }

        // ── State mutations ──

        // 12. Mark nullifiers
        nullifiers[ap.nullifier] = true;
        nonceNullifiers[ap.nonceNullifier] = true;

        // 13. Insert residual commitment (change UTXO)
        SettleVerifyLib.maybeInsertCommitment(pool, ap.newCommitment);

        // 14. Transfer totalLocked from pool to settlement (for claims)
        if (ap.totalLocked > 0) {
            pool.transferToSettlement(ap.sellToken, ap.totalLocked);
        }

        // 15. Route fee from pool to relayer (or FeeVault)
        if (p.fee > 0) _routeFeeFromPool(ap.sellToken, p.fee);

        SettleVerifyLib.registerClaimsGroup(claimsGroups, ap.claimsRoot, ap.sellToken, ap.totalLocked, ap.tier);

        emit ScatterDirectAuthSettled(ap.nullifier, ap.nonceNullifier, ap.claimsRoot, ap.relayer, p.fee);
    }

    // ─── Claim ───────────────────────────────────────────────────

    /// @notice Calldata struct for a single claim within `claimWithProofBatch`.
    struct ClaimParams {
        uint[2] proofA;
        uint[2][2] proofB;
        uint[2] proofC;
        bytes32 claimsRoot;
        bytes32 claimNullifier;
        uint256 amount;
        address token;
        address recipient;
        uint256 releaseTime;
    }

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
        _executeClaim(
            proofA, proofB, proofC,
            claimsRoot, claimNullifier,
            amount, token, recipient, releaseTime
        );
    }

    /// @notice Batch variant: execute multiple claims in one tx.
    /// @dev    Each claim is independently verified (no circuit-level aggregation).
    ///         Reverts atomically if any claim fails — callers must ensure every
    ///         element is individually valid. Capped by `MAX_CLAIM_BATCH_SIZE`
    ///         to stay within block gas limits; frontends should chunk larger sets.
    function claimWithProofBatch(ClaimParams[] calldata claims) external nonReentrant {
        if (paused) revert ContractPaused();
        uint256 n = claims.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_CLAIM_BATCH_SIZE) revert BatchTooLarge();

        for (uint256 i = 0; i < n;) {
            ClaimParams calldata c = claims[i];
            _executeClaim(
                c.proofA, c.proofB, c.proofC,
                c.claimsRoot, c.claimNullifier,
                c.amount, c.token, c.recipient, c.releaseTime
            );
            unchecked { ++i; }
        }
    }

    /// @dev Assumes `paused` already checked and reentrancy lock already held by the caller.
    function _executeClaim(
        uint[2] calldata proofA,
        uint[2][2] calldata proofB,
        uint[2] calldata proofC,
        bytes32 claimsRoot,
        bytes32 claimNullifier,
        uint256 amount,
        address token,
        address recipient,
        uint256 releaseTime
    ) internal {
        if (recipient == address(0)) revert ZeroAddress();
        _requireNotSanctioned(recipient);

        SettleVerifyLib.ClaimsGroup storage group = claimsGroups[claimsRoot];
        if (group.token == address(0)) revert ClaimsGroupNotFound();
        if (claimNullifiers[claimNullifier]) revert NullifierAlreadySpent();
        if (amount > type(uint128).max) revert AmountOverflow();
        if (group.totalClaimed + uint128(amount) > group.totalLocked) revert ExceedsTotalLocked();
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

        IClaimVerifier _verifier = claimVerifierByTier[group.tier];
        if (address(_verifier) == address(0)) revert TierNotConfigured(group.tier);
        if (!_verifier.verifyProof(proofA, proofB, proofC, pubSignals)) {
            revert InvalidProof();
        }

        // Mark nullifier + update claimed
        claimNullifiers[claimNullifier] = true;
        group.totalClaimed += uint128(amount);

        // Transfer tokens — unwrap WETH to ETH if applicable
        if (token == weth) {
            IWETH(weth).withdraw(amount);
            Address.sendValue(payable(recipient), amount);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }

        emit PrivateClaim(claimsRoot, claimNullifier, recipient, token, amount);
    }

    // ─── Claim to Pool ───────────────────────────────────────────

    /// @notice One slice of a `claimToPool` split. Each slice carries its
    ///         own deposit ZK proof so the contract enforces the
    ///         CommitmentPool's v2 commitment scheme:
    ///         `commitment = Poseidon(TAG_COMMITMENT_V2, ownerSecret,
    ///          token, amount, salt, pubKeyAx, pubKeyAy)` — same binding
    ///         the pool's `deposit()` enforces via its deposit verifier.
    ///         The owner pubkey can be the caller's own EdDSA key (most
    ///         common — anonymity-set use case) or any third party's
    ///         (forwarding via off-chain secret hand-off). The contract
    ///         doesn't care; only the deposit proof's binding matters.
    struct ClaimToPoolSlice {
        uint[2] proofA;
        uint[2][2] proofB;
        uint[2] proofC;
        uint256 commitment;
        uint256 amount;
    }

    /// @notice `claimToPool` parameters bundled into a struct so the
    ///         entry function stays under Solidity's 16-slot stack
    ///         limit without flipping on via-ir. Mirrors the EIP-712
    ///         payload's logical fields plus the proof's verification
    ///         inputs.
    struct ClaimToPoolParams {
        uint[2] claimProofA;
        uint[2][2] claimProofB;
        uint[2] claimProofC;
        bytes32 claimsRoot;
        bytes32 claimNullifier;
        uint256 amount;
        address token;
        address stealthRecipient;
        uint256 releaseTime;
    }

    /// @notice Atomically claim a stealth payment and route the output
    ///         into N fresh CommitmentPool deposits. Replaces the
    ///         privacy-leaking two-step (claim → stealth EOA →
    ///         redeposit) with a single tx that doesn't require the
    ///         stealth EOA to hold gas.
    ///
    /// @dev    Cryptographic authentication:
    ///         - **Claim ZK proof**: identical binding as
    ///           `claimWithProof` — recipient stays as
    ///           `stealthRecipient` (the address baked into the
    ///           claims-tree leaf at settle-time). No circuit changes.
    ///         - **EIP-712 signature**: `stealthRecipient` (= the
    ///           privkey holder) signs `ClaimToPoolAuth(claimNullifier,
    ///           amount, token, slicesHash)`. `slicesHash` covers the
    ///           full slices array including each slice's deposit
    ///           proof, so a mempool observer cannot substitute their
    ///           own commitments — the signature would no longer
    ///           recover to `stealthRecipient`.
    ///
    ///         Cross-flow replay safety:
    ///         - The same `claimNullifiers` slot is consumed as
    ///           `claimWithProof`; a stealth payment can be claimed
    ///           via either path, but only once across both.
    ///         - `claimWithProof` accepts the same proof but requires
    ///           no signature, so a frontrunner copying the proof
    ///           would only succeed at the *normal* claim flow
    ///           (paying `stealthRecipient`'s EOA) — funds still reach
    ///           the user, just at a different destination.
    function claimToPool(
        ClaimToPoolParams calldata p,
        ClaimToPoolSlice[] calldata slices,
        bytes calldata stealthSignature
    ) external nonReentrant {
        if (paused) revert ContractPaused();
        if (p.stealthRecipient == address(0)) revert ZeroAddress();
        _requireNotSanctioned(p.stealthRecipient);

        // Validate slice payload + claim group state BEFORE any
        // mutation. Returns slicesHash for the EIP-712 digest.
        bytes32 slicesHash = _validateClaimToPoolPayload(
            slices, p.claimsRoot, p.claimNullifier, p.amount, p.token, p.releaseTime
        );

        // Verify EIP-712 sig + claim ZK proof in two separate helpers
        // to keep this function under Solidity's 16-slot stack limit
        // without flipping on via-ir.
        _verifyStealthSignature(
            p.claimNullifier, p.amount, p.token, slicesHash, p.stealthRecipient, stealthSignature
        );
        _verifyClaimProofToPool(
            p.claimProofA, p.claimProofB, p.claimProofC,
            p.claimsRoot, p.claimNullifier, p.amount, p.token, p.stealthRecipient, p.releaseTime
        );

        // Mark nullifier + advance group claimed before any external
        // call. After this point a revert rolls back both, preserving
        // the user's option to retry.
        claimNullifiers[p.claimNullifier] = true;
        claimsGroups[p.claimsRoot].totalClaimed += uint128(p.amount);

        // Single forceApprove for the total then loop pool.deposit
        // per slice. pool.deposit verifies the deposit ZK proof, runs
        // the fee-on-transfer balance-delta check, and enforces field
        // bounds — reusing the existing pool entry's safety net. No
        // WETH unwrap branch — the pool wants the ERC20.
        IERC20(p.token).forceApprove(address(pool), p.amount);
        _depositSlicesToPool(slices, p.token);
        // Defensive reset: with the sum check above, pool.deposit
        // consumes exactly `amount` and the allowance lands at zero
        // already. Explicit reset is a belt-and-suspenders guard
        // against a future bug in pool.deposit (or a fee-on-transfer
        // edge case its balance-delta check misses) leaving residual
        // approval that another caller could exploit.
        IERC20(p.token).forceApprove(address(pool), 0);

        emit PrivateClaimToPool(
            p.claimsRoot, p.claimNullifier, p.stealthRecipient, p.token, p.amount, slices.length
        );
    }

    /// @dev Per-slice loop calling `pool.deposit` for each slice.
    ///      Extracted so the parent `claimToPool` stays under
    ///      Solidity's 16-slot local-variable limit.
    function _depositSlicesToPool(
        ClaimToPoolSlice[] calldata slices,
        address token
    ) internal {
        uint256 n = slices.length;
        for (uint256 i = 0; i < n;) {
            ClaimToPoolSlice calldata s = slices[i];
            pool.deposit(s.proofA, s.proofB, s.proofC, s.commitment, token, s.amount);
            unchecked { ++i; }
        }
    }

    /// @dev Slice-payload + claim-group validation extracted from
    ///      `claimToPool` to keep the parent under Solidity's 16-slot
    ///      local-variable limit without flipping on via-ir.
    ///      Reverts on any invariant violation; never mutates state.
    ///      Returns `slicesHash` so the caller can include it in the
    ///      EIP-712 digest without rehashing the calldata.
    function _validateClaimToPoolPayload(
        ClaimToPoolSlice[] calldata slices,
        bytes32 claimsRoot,
        bytes32 claimNullifier,
        uint256 amount,
        address token,
        uint256 releaseTime
    ) internal view returns (bytes32 slicesHash) {
        uint256 n = slices.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_CLAIM_TO_POOL_SLICES) revert TooManySlices();
        // Bound amount upfront so the per-slice `s.amount <= amount`
        // check below transitively bounds individual slices, making the
        // uint256 sum accumulator overflow-safe. uint256 arithmetic for
        // the totalLocked check so Panic(0x11) on uint128 overflow
        // never preempts the explicit ExceedsTotalLocked error.
        if (amount > type(uint128).max) revert AmountOverflow();

        SettleVerifyLib.ClaimsGroup storage group = claimsGroups[claimsRoot];
        if (group.token == address(0)) revert ClaimsGroupNotFound();
        if (claimNullifiers[claimNullifier]) revert NullifierAlreadySpent();
        if (uint256(group.totalClaimed) + amount > group.totalLocked) revert ExceedsTotalLocked();
        if (block.timestamp < releaseTime) revert NotYetReleasable();
        if (token != group.token) revert TokenMismatch();

        // Sum + per-slice validation. `s.amount > amount` keeps each
        // slice ≤ total, so the uint256 accumulator can't overflow.
        uint256 sum;
        for (uint256 i = 0; i < n;) {
            ClaimToPoolSlice calldata s = slices[i];
            if (s.commitment == 0 || s.amount == 0 || s.amount > amount) revert InvalidSlice();
            sum += s.amount;
            unchecked { ++i; }
        }
        if (sum != amount) revert SumMismatch();

        // Hash the entire slices array — including each slice's
        // deposit proof — so the EIP-712 signature binds every byte
        // of the payload. `keccak256(abi.encode(slices))` is
        // deterministic on calldata.
        slicesHash = keccak256(abi.encode(slices));
    }

    /// @dev EIP-712 signature recover for `claimToPool`. Extracted so
    ///      its locals don't pile onto the parent's stack. tryRecover
    ///      normalizes every malformed-signature mode into a single
    ///      `InvalidStealthSignature` revert for stable caller UX.
    function _verifyStealthSignature(
        bytes32 claimNullifier,
        uint256 amount,
        address token,
        bytes32 slicesHash,
        address expectedSigner,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(abi.encode(
            CLAIM_TO_POOL_AUTH_TYPEHASH,
            claimNullifier,
            amount,
            token,
            slicesHash
        ));
        bytes32 domainSeparator = keccak256(abi.encode(
            _EIP712_DOMAIN_TYPEHASH,
            _EIP712_HASHED_NAME,
            _EIP712_HASHED_VERSION,
            block.chainid,
            address(this)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (address signer, ECDSA.RecoverError err, ) = digest.tryRecover(signature);
        if (err != ECDSA.RecoverError.NoError || signer != expectedSigner) {
            revert InvalidStealthSignature();
        }
    }

    /// @dev Claim ZK proof verification for `claimToPool`. Same
    ///      circuit + same public-signal layout as `claimWithProof`;
    ///      `recipient` stays as the stealth address (matches leaf).
    ///      Extracted to keep the parent function's stack within the
    ///      16-slot limit.
    function _verifyClaimProofToPool(
        uint[2] calldata claimProofA,
        uint[2][2] calldata claimProofB,
        uint[2] calldata claimProofC,
        bytes32 claimsRoot,
        bytes32 claimNullifier,
        uint256 amount,
        address token,
        address stealthRecipient,
        uint256 releaseTime
    ) internal view {
        SettleVerifyLib.ClaimsGroup storage group = claimsGroups[claimsRoot];
        IClaimVerifier _verifier = claimVerifierByTier[group.tier];
        if (address(_verifier) == address(0)) revert TierNotConfigured(group.tier);
        uint[6] memory pubSignals = [
            uint256(claimsRoot),
            uint256(claimNullifier),
            amount,
            uint256(uint160(token)),
            uint256(uint160(stealthRecipient)),
            releaseTime
        ];
        if (!_verifier.verifyProof(claimProofA, claimProofB, claimProofC, pubSignals)) {
            revert InvalidProof();
        }
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
