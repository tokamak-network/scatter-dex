// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IdentityGate} from "./IdentityGate.sol";
import {RelayerRegistry} from "./RelayerRegistry.sol";

contract ScatterSettlement is EIP712, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant REFUND_WINDOW = 7 days;
    uint256 public constant MIN_RELEASE_DELAY = 1 hours;
    uint256 public constant MAX_CLAIMS_PER_ORDER = 10;
    uint256 public constant FEE_DENOMINATOR = 10000;
    uint256 public constant MAX_PROTOCOL_FEE = 5000; // 50% of total fee

    // ─── Custom Errors ───────────────────────────────────────────────
    error NotVerified();
    error ZeroAmount();
    error InsufficientBalance();
    error InvalidSignature();
    error NonceConsumed();
    error OrderExpired();
    error TokenMismatch();
    error PriceIncompatible();
    error FeeExceedsMax();
    error InvalidClaimCount();
    error ZeroClaimAmount();
    error ClaimsSumMismatch();
    error InsufficientEscrow();
    error ScheduleNotFound();
    error AlreadyClaimed();
    error NotYetReleasable();
    error ClaimWindowNotExpired();
    error NotDepositor();
    error AmountOverflow();
    error ReleaseDelayOverflow();
    error SelfTrade();
    error NotActiveRelayer();
    error FeeTooHigh();
    error ZeroAddress();
    error FeeExceedsRelayerRegistered();
    error ContractPaused();
    error DuplicateClaimHash();
    error TokenNotWhitelisted();
    error ReleaseDelayTooShort();
    error TipExceedsAmount();
    error SignatureExpired();
    error RenounceOwnershipDisabled();

    // ─── Data Structures ─────────────────────────────────────────────
    enum NonceState { Unused, Settled, Cancelled }

    struct ClaimInfo {
        bytes32 claimHash; // keccak256(abi.encodePacked(secret, recipient))
        uint256 amount;
        uint256 releaseDelay; // seconds after settle
    }

    struct Order {
        address maker;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        uint256 maxFee; // basis points
        uint256 expiry;
        uint256 nonce;
        ClaimInfo[] claims;
    }

    // Packed: 2 storage slots (claimHash used as mapping key instead of stored in struct)
    // Slot 0: token (20) + releaseTime (6) + claimed (1) = 27 bytes
    // Slot 1: depositor (20) + amount (12) = 32 bytes
    struct ClaimSchedule {
        address token;           // slot 0: 20 bytes
        uint48 releaseTime;      // slot 0: 6 bytes
        bool claimed;            // slot 0: 1 byte
        address depositor;       // slot 1: 20 bytes
        uint96 amount;           // slot 1: 12 bytes
    }

    // ─── EIP-712 TypeHashes ──────────────────────────────────────────
    bytes32 public constant CLAIM_INFO_TYPEHASH =
        keccak256("ClaimInfo(bytes32 claimHash,uint256 amount,uint256 releaseDelay)");

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 maxFee,uint256 expiry,uint256 nonce,ClaimInfo[] claims)ClaimInfo(bytes32 claimHash,uint256 amount,uint256 releaseDelay)"
    );

    bytes32 public constant GASLESS_CLAIM_TYPEHASH =
        keccak256("GaslessClaim(bytes32 secret,address recipient,address relayer,uint256 relayerTip,uint256 deadline,uint256 nonce)");

    bytes32 public constant CANCEL_GASLESS_CLAIM_TYPEHASH =
        keccak256("CancelGaslessClaim(address recipient,uint256 nonce)");

    // ─── State ───────────────────────────────────────────────────────
    IdentityGate public immutable identityGate;
    RelayerRegistry public immutable relayerRegistry;

    /// @notice Protocol fee in basis points (e.g., 10 = 0.1%). Taken from total fee.
    uint256 public protocolFeeBps;
    bool public paused;

    // depositor => token => amount
    mapping(address => mapping(address => uint256)) public deposits;

    // claimHash => ClaimSchedule (claimHash is the key, not stored in struct)
    mapping(bytes32 => ClaimSchedule) public schedules;

    // maker => nonce => state (Unused / Settled / Cancelled)
    mapping(address => mapping(uint256 => NonceState)) public nonces;

    // token => whitelisted
    mapping(address => bool) public whitelistedTokens;

    // recipient => gasless claim nonce (incremented on successful claimReleaseFor and on cancel,
    // so each gasless claim signature is single-use and cancel invalidates all outstanding signatures)
    mapping(address => uint256) public gaslessNonces;

    // ─── Events ──────────────────────────────────────────────────────
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event TokenWhitelistUpdated(address indexed token, bool allowed);
    event Settled(address indexed maker, address indexed taker, bytes32[] claimHashes);
    event Claimed(bytes32 indexed claimHash, address indexed recipient, address indexed token, uint256 amount);
    event ClaimedFor(bytes32 indexed claimHash, address indexed recipient, address indexed token, address relayer, uint256 recipientAmount, uint256 relayerTip);
    event GaslessClaimCancelled(address indexed recipient, uint256 newNonce);
    event Refunded(bytes32 indexed claimHash, address indexed depositor, uint256 amount);
    event NonceCancelled(address indexed user, uint256 nonce);
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);
    event Paused(address account);
    event Unpaused(address account);

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _identityGate, address _relayerRegistry, uint256 _protocolFeeBps)
        EIP712("ScatterSettlement", "1")
        Ownable(msg.sender)
    {
        if (_identityGate == address(0) || _relayerRegistry == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE) revert FeeTooHigh();
        identityGate = IdentityGate(_identityGate);
        relayerRegistry = RelayerRegistry(_relayerRegistry);
        protocolFeeBps = _protocolFeeBps;
    }

    /// @dev Disable renounceOwnership to prevent accidental lockout of admin functions.
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    /// @dev Override to reject zero-address transfers, preserving the original contract's behavior.
    function transferOwnership(address newOwner) public override {
        if (newOwner == address(0)) revert ZeroAddress();
        super.transferOwnership(newOwner);
    }

    function setProtocolFee(uint256 _protocolFeeBps) external onlyOwner {
        if (_protocolFeeBps > MAX_PROTOCOL_FEE) revert FeeTooHigh();
        emit ProtocolFeeUpdated(protocolFeeBps, _protocolFeeBps);
        protocolFeeBps = _protocolFeeBps;
    }

    function setTokenWhitelist(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        whitelistedTokens[token] = allowed;
        emit TokenWhitelistUpdated(token, allowed);
    }

    /// @notice Emergency pause/unpause. Unpause takes effect immediately.
    /// @dev In this reference implementation, `owner` can both pause and unpause.
    ///      For production, a common pattern is to:
    ///      - keep a fast-acting "pause guardian" (not timelocked) that can pause immediately, and
    ///      - put `owner` / governance behind a Timelock for unpauses and other admin actions.
    ///      If `owner` is timelocked, ensure a separate immediate pause authority remains. See audit L-2.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        if (_paused) emit Paused(msg.sender);
        else emit Unpaused(msg.sender);
    }

    // ─── Deposit & Withdraw ──────────────────────────────────────────

    /// @notice Deposit tokens into escrow. Only whitelisted tokens accepted.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (!whitelistedTokens[token]) revert TokenNotWhitelisted();
        if (!identityGate.isVerified(msg.sender)) revert NotVerified();
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender][token] += amount;

        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Withdraw unmatched escrow funds.
    /// @dev No identity check — intentional. Users must always be able to recover
    ///      their funds even after certificate expiry or revocation, to prevent
    ///      permanent fund lockup. See security audit M-4.
    function withdraw(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (deposits[msg.sender][token] < amount) revert InsufficientBalance();

        deposits[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, token, amount);
    }

    // ─── Cancel ──────────────────────────────────────────────────────
    function cancelOrder(uint256 nonce) external {
        if (nonces[msg.sender][nonce] != NonceState.Unused) revert NonceConsumed();
        nonces[msg.sender][nonce] = NonceState.Cancelled;
        emit NonceCancelled(msg.sender, nonce);
    }

    // ─── Settle ──────────────────────────────────────────────────────

    /// @notice Settle a matched maker-taker order pair.
    /// @dev Fees are split: makerFee is deducted from maker's sellAmount,
    ///      takerFee is deducted from taker's sellAmount.
    ///      Each fee must be ≤ the respective order's maxFee and ≤ relayer's registered fee.
    ///      This allows the order creator to absorb the full fee (e.g., makerFee=60, takerFee=0).
    function settle(
        bytes calldata makerSig,
        bytes calldata takerSig,
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256 makerFee,
        uint256 takerFee
    ) external nonReentrant {
        if (paused) revert ContractPaused();

        // Single external call replaces isActiveRelayer() + getFee() + treasury()
        (bool isActive, uint256 relayerFee, address treasury) = relayerRegistry.getSettlementInfo(msg.sender);
        if (!isActive) revert NotActiveRelayer();
        if (makerFee > relayerFee) revert FeeExceedsRelayerRegistered();
        if (takerFee > relayerFee) revert FeeExceedsRelayerRegistered();

        _validateSettle(makerSig, takerSig, makerOrder, takerOrder, makerFee, takerFee);

        // Consume nonces
        nonces[makerOrder.maker][makerOrder.nonce] = NonceState.Settled;
        nonces[takerOrder.maker][takerOrder.nonce] = NonceState.Settled;

        // Deduct escrow
        deposits[makerOrder.maker][makerOrder.sellToken] -= makerOrder.sellAmount;
        deposits[takerOrder.maker][takerOrder.sellToken] -= takerOrder.sellAmount;

        // Split fee: relayer + protocol (cache protocolFeeBps to avoid repeated SLOAD)
        uint256 cachedProtocolFeeBps = protocolFeeBps;
        _splitAndPayFee(makerOrder.sellToken, makerOrder.sellAmount, makerFee, treasury, cachedProtocolFeeBps);
        _splitAndPayFee(takerOrder.sellToken, takerOrder.sellAmount, takerFee, treasury, cachedProtocolFeeBps);

        // Create claim schedules and emit
        bytes32[] memory claimHashes = _createSchedules(makerOrder, takerOrder);
        emit Settled(makerOrder.maker, takerOrder.maker, claimHashes);
    }

    // ─── Claim ───────────────────────────────────────────────────────

    /// @notice Claim funds using the secret provided by the depositor.
    /// @dev claimHash = keccak256(abi.encodePacked(secret, msg.sender)) is computed internally.
    ///      Each (secret, recipient) pair can only be used once — depositors must
    ///      generate a unique random secret per claim to avoid collisions. See audit M-3.
    function claimRelease(bytes32 secret) external nonReentrant {
        if (paused) revert ContractPaused();
        bytes32 claimHash;
        assembly { mstore(0x00, secret) mstore(0x20, shl(96, caller())) claimHash := keccak256(0x00, 0x34) }
        (uint96 amt, address token) = _validateAndMarkClaimed(claimHash);

        IERC20(token).safeTransfer(msg.sender, amt);
        emit Claimed(claimHash, msg.sender, token, amt);
    }

    /// @notice Gasless claim — a relayer calls on behalf of the recipient.
    /// @dev The recipient signs an EIP-712 message binding the specific relayer, tip, and deadline.
    ///      Only the designated relayer (msg.sender) can submit this signature — prevents
    ///      mempool tip theft by other relayers. The relayer pays gas and receives `relayerTip`.
    ///      To revoke: call cancelGaslessClaimFor() which increments the nonce.
    /// @param secret The secret shared by the depositor
    /// @param recipient The intended recipient (whose address is bound in claimHash)
    /// @param relayerTip Amount (in claim token) paid to msg.sender as gas compensation
    /// @param deadline Unix timestamp after which this signature is no longer valid
    /// @param recipientSig EIP-712 signature from recipient authorizing (secret, recipient, relayer, relayerTip, deadline, nonce)
    function claimReleaseFor(
        bytes32 secret,
        address recipient,
        uint256 relayerTip,
        uint256 deadline,
        bytes calldata recipientSig
    ) external nonReentrant {
        if (paused) revert ContractPaused();
        if (block.timestamp > deadline) revert SignatureExpired();

        uint256 currentNonce = gaslessNonces[recipient];
        bytes32 structHash;
        {
            bytes32 th = GASLESS_CLAIM_TYPEHASH;
            assembly {
                let p := mload(0x40)
                mstore(p, th)
                mstore(add(p, 0x20), secret)
                mstore(add(p, 0x40), recipient)
                mstore(add(p, 0x60), caller())
                mstore(add(p, 0x80), relayerTip)
                mstore(add(p, 0xa0), deadline)
                mstore(add(p, 0xc0), currentNonce)
                structHash := keccak256(p, 0xe0)
            }
        }
        if (ECDSA.recover(_hashTypedDataV4(structHash), recipientSig) != recipient) revert InvalidSignature();

        gaslessNonces[recipient] = currentNonce + 1;

        bytes32 claimHash;
        assembly { mstore(0x00, secret) mstore(0x20, shl(96, recipient)) claimHash := keccak256(0x00, 0x34) }
        (uint96 amt, address token) = _validateAndMarkClaimed(claimHash);
        if (relayerTip > amt) revert TipExceedsAmount();

        uint256 recipientAmount = uint256(amt) - relayerTip;
        if (recipientAmount > 0) {
            IERC20(token).safeTransfer(recipient, recipientAmount);
        }
        if (relayerTip > 0) {
            IERC20(token).safeTransfer(msg.sender, relayerTip);
        }

        emit ClaimedFor(claimHash, recipient, token, msg.sender, recipientAmount, relayerTip);
    }

    /// @notice Cancel all outstanding gasless claim signatures for a recipient.
    /// @dev Anyone can call this with a valid signature from the recipient.
    ///      Increments the recipient's nonce, invalidating all prior signatures.
    ///      The recipient signs a CancelGaslessClaim message off-chain, and any
    ///      third party (friend, another relayer) submits it — no ETH needed by recipient.
    function cancelGaslessClaimFor(address recipient, bytes calldata recipientSig) external {
        uint256 currentNonce = gaslessNonces[recipient];
        bytes32 cancelTypeHash = CANCEL_GASLESS_CLAIM_TYPEHASH;
        bytes32 structHash;
        assembly {
            let p := mload(0x40)
            mstore(p, cancelTypeHash)
            mstore(add(p, 0x20), recipient)
            mstore(add(p, 0x40), currentNonce)
            structHash := keccak256(p, 0x60)
        }
        if (ECDSA.recover(_hashTypedDataV4(structHash), recipientSig) != recipient) revert InvalidSignature();

        gaslessNonces[recipient] = currentNonce + 1;
        emit GaslessClaimCancelled(recipient, currentNonce + 1);
    }

    // ─── Refund (no pause check — refunds must always work to prevent fund lockup) ──
    function refundUnclaimed(bytes32 claimHash) external nonReentrant {
        ClaimSchedule storage schedule = schedules[claimHash];
        uint96 amt = schedule.amount;
        if (amt == 0) revert ScheduleNotFound();
        if (schedule.claimed) revert AlreadyClaimed();
        if (block.timestamp < uint256(schedule.releaseTime) + REFUND_WINDOW) revert ClaimWindowNotExpired();
        if (msg.sender != schedule.depositor) revert NotDepositor();

        schedule.claimed = true;
        deposits[schedule.depositor][schedule.token] += amt;

        emit Refunded(claimHash, schedule.depositor, amt);
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Shared validation for claimRelease and claimReleaseFor.
    function _validateAndMarkClaimed(bytes32 claimHash) internal returns (uint96 amt, address token) {
        ClaimSchedule storage schedule = schedules[claimHash];
        amt = schedule.amount;
        if (amt == 0) revert ScheduleNotFound();
        if (schedule.claimed) revert AlreadyClaimed();
        if (block.timestamp < schedule.releaseTime) revert NotYetReleasable();
        schedule.claimed = true;
        token = schedule.token;
    }

    function _createSchedules(
        Order calldata makerOrder,
        Order calldata takerOrder
    ) internal returns (bytes32[] memory claimHashes) {
        uint256 totalClaims = makerOrder.claims.length + takerOrder.claims.length;
        claimHashes = new bytes32[](totalClaims);
        uint48 now48 = uint48(block.timestamp);

        // claimHash is permanently consumed — amount is never cleared after claim/refund.
        // Depositors must use a unique random secret per recipient per trade.

        // Maker receives taker's sellToken
        for (uint256 i; i < makerOrder.claims.length; ++i) {
            bytes32 ch = makerOrder.claims[i].claimHash;
            if (schedules[ch].amount != 0) revert DuplicateClaimHash();
            (uint96 safeAmt, uint48 safeTime) = _safeCastClaim(makerOrder.claims[i], now48);
            schedules[ch] = ClaimSchedule({
                token: takerOrder.sellToken,
                amount: safeAmt,
                releaseTime: safeTime,
                claimed: false,
                depositor: makerOrder.maker
            });
            claimHashes[i] = ch;
        }

        // Taker receives maker's sellToken
        uint256 makerLen = makerOrder.claims.length;
        for (uint256 i; i < takerOrder.claims.length; ++i) {
            bytes32 ch = takerOrder.claims[i].claimHash;
            if (schedules[ch].amount != 0) revert DuplicateClaimHash();
            (uint96 safeAmt, uint48 safeTime) = _safeCastClaim(takerOrder.claims[i], now48);
            schedules[ch] = ClaimSchedule({
                token: makerOrder.sellToken,
                amount: safeAmt,
                releaseTime: safeTime,
                claimed: false,
                depositor: takerOrder.maker
            });
            claimHashes[makerLen + i] = ch;
        }
    }

    function _splitAndPayFee(address token, uint256 sellAmount, uint256 feeRate, address treasury, uint256 cachedProtocolFeeBps) internal {
        uint256 totalFee = (sellAmount * feeRate) / FEE_DENOMINATOR;
        if (totalFee == 0) return;

        // NOTE: integer division rounds protocolCut down (at most 1 wei loss).
        // Relayer gets the remainder, so rounding favors the relayer.
        uint256 protocolCut = (totalFee * cachedProtocolFeeBps) / FEE_DENOMINATOR;
        uint256 relayerCut = totalFee - protocolCut;

        if (relayerCut > 0) {
            IERC20(token).safeTransfer(msg.sender, relayerCut);
        }
        if (protocolCut > 0) {
            IERC20(token).safeTransfer(treasury, protocolCut);
        }
    }

    function _validateSettle(
        bytes calldata makerSig,
        bytes calldata takerSig,
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256 makerFee,
        uint256 takerFee
    ) internal view {
        // Verify not self-trade
        if (makerOrder.maker == takerOrder.maker) revert SelfTrade();

        // Verify signatures
        bytes32 makerHash = _hashOrder(makerOrder);
        bytes32 takerHash = _hashOrder(takerOrder);
        if (ECDSA.recover(makerHash, makerSig) != makerOrder.maker) revert InvalidSignature();
        if (ECDSA.recover(takerHash, takerSig) != takerOrder.maker) revert InvalidSignature();

        // Verify nonces
        if (nonces[makerOrder.maker][makerOrder.nonce] != NonceState.Unused) revert NonceConsumed();
        if (nonces[takerOrder.maker][takerOrder.nonce] != NonceState.Unused) revert NonceConsumed();

        // Verify expiry
        if (block.timestamp > makerOrder.expiry) revert OrderExpired();
        if (block.timestamp > takerOrder.expiry) revert OrderExpired();

        // Verify token compatibility
        if (makerOrder.sellToken != takerOrder.buyToken) revert TokenMismatch();
        if (makerOrder.buyToken != takerOrder.sellToken) revert TokenMismatch();

        // Verify tokens are whitelisted
        if (!whitelistedTokens[makerOrder.sellToken]) revert TokenNotWhitelisted();
        if (!whitelistedTokens[makerOrder.buyToken]) revert TokenNotWhitelisted();

        // Verify price compatibility: maker.sell * taker.sell <= maker.buy * taker.buy
        if (makerOrder.sellAmount * takerOrder.sellAmount > makerOrder.buyAmount * takerOrder.buyAmount) {
            revert PriceIncompatible();
        }

        // Verify fees — each side's fee must be ≤ their signed maxFee
        if (makerFee > makerOrder.maxFee) revert FeeExceedsMax();
        if (takerFee > takerOrder.maxFee) revert FeeExceedsMax();

        // Verify claim counts
        uint256 makerClaimsLen = makerOrder.claims.length;
        uint256 takerClaimsLen = takerOrder.claims.length;
        if (makerClaimsLen == 0 || makerClaimsLen > MAX_CLAIMS_PER_ORDER) revert InvalidClaimCount();
        if (takerClaimsLen == 0 || takerClaimsLen > MAX_CLAIMS_PER_ORDER) revert InvalidClaimCount();

        // Verify claim amounts — maker receives from taker's sell (minus taker's fee),
        // taker receives from maker's sell (minus maker's fee)
        _verifyClaims(makerOrder.claims, takerOrder.sellAmount, takerFee);
        _verifyClaims(takerOrder.claims, makerOrder.sellAmount, makerFee);

        // Verify escrow
        if (deposits[makerOrder.maker][makerOrder.sellToken] < makerOrder.sellAmount) revert InsufficientEscrow();
        if (deposits[takerOrder.maker][takerOrder.sellToken] < takerOrder.sellAmount) revert InsufficientEscrow();
    }

    function _hashOrder(Order calldata order) internal view returns (bytes32) {
        bytes32[] memory claimHashes = new bytes32[](order.claims.length);
        for (uint256 i; i < order.claims.length; ++i) {
            claimHashes[i] = keccak256(
                abi.encode(
                    CLAIM_INFO_TYPEHASH,
                    order.claims[i].claimHash,
                    order.claims[i].amount,
                    order.claims[i].releaseDelay
                )
            );
        }

        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.maker,
                    order.sellToken,
                    order.buyToken,
                    order.sellAmount,
                    order.buyAmount,
                    order.maxFee,
                    order.expiry,
                    order.nonce,
                    keccak256(abi.encodePacked(claimHashes))
                )
            )
        );
    }

    function _safeCastClaim(ClaimInfo calldata claim, uint48 now48) internal pure returns (uint96, uint48) {
        if (claim.amount > type(uint96).max) revert AmountOverflow();
        if (claim.releaseDelay < MIN_RELEASE_DELAY) revert ReleaseDelayTooShort();
        if (claim.releaseDelay > type(uint48).max - now48) revert ReleaseDelayOverflow();
        return (uint96(claim.amount), now48 + uint48(claim.releaseDelay));
    }

    function _verifyClaims(ClaimInfo[] calldata claims, uint256 receiveAmount, uint256 feeRate) internal pure {
        uint256 fee = (receiveAmount * feeRate) / FEE_DENOMINATOR;
        uint256 distributable = receiveAmount - fee;
        uint256 totalClaimed;
        for (uint256 i; i < claims.length; ++i) {
            if (claims[i].amount == 0) revert ZeroClaimAmount();
            totalClaimed += claims[i].amount;
        }
        if (totalClaimed != distributable) revert ClaimsSumMismatch();
    }
}
