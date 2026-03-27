// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IdentityGate} from "./IdentityGate.sol";
import {RelayerRegistry} from "./RelayerRegistry.sol";

contract ScatterSettlement is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant REFUND_WINDOW = 7 days;
    uint256 public constant MAX_CLAIMS_PER_ORDER = 10;
    uint256 public constant FEE_DENOMINATOR = 10000;

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
    error InvalidSecretOrAddress();
    error ClaimWindowNotExpired();
    error NotDepositor();
    error AmountOverflow();
    error ReleaseDelayOverflow();
    error SelfTrade();
    error NotActiveRelayer();
    error NotOwner();

    // ─── Data Structures ─────────────────────────────────────────────
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

    // Packed: 3 storage slots (down from 6)
    // Slot 0: claimHash (bytes32)
    // Slot 1: token (20) + releaseTime (6) + claimed (1) = 27 bytes
    // Slot 2: depositor (20) + amount (12) = 32 bytes
    struct ClaimSchedule {
        bytes32 claimHash;       // slot 0
        address token;           // slot 1: 20 bytes
        uint48 releaseTime;      // slot 1: 6 bytes
        bool claimed;            // slot 1: 1 byte
        address depositor;       // slot 2: 20 bytes
        uint96 amount;           // slot 2: 12 bytes
    }

    // ─── EIP-712 TypeHashes ──────────────────────────────────────────
    bytes32 public constant CLAIM_INFO_TYPEHASH =
        keccak256("ClaimInfo(bytes32 claimHash,uint256 amount,uint256 releaseDelay)");

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 maxFee,uint256 expiry,uint256 nonce,ClaimInfo[] claims)ClaimInfo(bytes32 claimHash,uint256 amount,uint256 releaseDelay)"
    );

    // ─── State ───────────────────────────────────────────────────────
    IdentityGate public immutable identityGate;
    RelayerRegistry public immutable relayerRegistry;

    /// @notice Protocol fee in basis points (e.g., 10 = 0.1%). Taken from total fee.
    uint256 public protocolFeeBps;
    address public owner;

    // depositor => token => amount
    mapping(address => mapping(address => uint256)) public deposits;

    // scheduleId => ClaimSchedule
    mapping(uint256 => ClaimSchedule) public schedules;
    uint256 public scheduleCount;

    // maker => nonce => consumed
    mapping(address => mapping(uint256 => bool)) public nonces;

    // ─── Events ──────────────────────────────────────────────────────
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Settled(uint256 indexed matchId, address indexed maker, address indexed taker, uint256[] scheduleIds);
    event Claimed(uint256 indexed scheduleId, address indexed recipient, address indexed token, uint256 amount);
    event Refunded(uint256 indexed scheduleId, address indexed depositor, uint256 amount);
    event NonceCancelled(address indexed user, uint256 nonce);
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _identityGate, address _relayerRegistry, uint256 _protocolFeeBps) EIP712("ScatterSettlement", "1") {
        identityGate = IdentityGate(_identityGate);
        relayerRegistry = RelayerRegistry(_relayerRegistry);
        protocolFeeBps = _protocolFeeBps;
        owner = msg.sender;
    }

    function setProtocolFee(uint256 _protocolFeeBps) external {
        if (msg.sender != owner) revert NotOwner();
        emit ProtocolFeeUpdated(protocolFeeBps, _protocolFeeBps);
        protocolFeeBps = _protocolFeeBps;
    }

    // ─── Deposit & Withdraw ──────────────────────────────────────────
    function deposit(address token, uint256 amount) external nonReentrant {
        if (!identityGate.isVerified(msg.sender)) revert NotVerified();
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender][token] += amount;

        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (deposits[msg.sender][token] < amount) revert InsufficientBalance();

        deposits[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, token, amount);
    }

    // ─── Cancel ──────────────────────────────────────────────────────
    function cancelOrder(uint256 nonce) external {
        if (nonces[msg.sender][nonce]) revert NonceConsumed();
        nonces[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    // ─── Settle ──────────────────────────────────────────────────────
    function settle(
        bytes calldata makerSig,
        bytes calldata takerSig,
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256 actualFee
    ) external nonReentrant {
        // Verify caller is a registered active relayer
        if (!relayerRegistry.isActiveRelayer(msg.sender)) revert NotActiveRelayer();

        _validateSettle(makerSig, takerSig, makerOrder, takerOrder, actualFee);

        // Consume nonces
        nonces[makerOrder.maker][makerOrder.nonce] = true;
        nonces[takerOrder.maker][takerOrder.nonce] = true;

        // Deduct escrow
        deposits[makerOrder.maker][makerOrder.sellToken] -= makerOrder.sellAmount;
        deposits[takerOrder.maker][takerOrder.sellToken] -= takerOrder.sellAmount;

        // Split fee: relayer + protocol
        address treasury = relayerRegistry.treasury();
        _splitAndPayFee(makerOrder.sellToken, makerOrder.sellAmount, actualFee, treasury);
        _splitAndPayFee(takerOrder.sellToken, takerOrder.sellAmount, actualFee, treasury);

        // Create claim schedules
        uint256 matchId = scheduleCount;
        uint256 totalClaims = makerOrder.claims.length + takerOrder.claims.length;
        uint256[] memory scheduleIds = new uint256[](totalClaims);

        uint256 sid = scheduleCount;
        uint48 now48 = uint48(block.timestamp);

        // Maker receives taker's sellToken
        for (uint256 i; i < makerOrder.claims.length; ++i) {
            (uint96 safeAmt, uint48 safeTime) = _safeCastClaim(makerOrder.claims[i], now48);
            schedules[sid] = ClaimSchedule({
                claimHash: makerOrder.claims[i].claimHash,
                token: takerOrder.sellToken,
                amount: safeAmt,
                releaseTime: safeTime,
                claimed: false,
                depositor: makerOrder.maker
            });
            scheduleIds[i] = sid;
            ++sid;
        }

        // Taker receives maker's sellToken
        uint256 makerLen = makerOrder.claims.length;
        for (uint256 i; i < takerOrder.claims.length; ++i) {
            (uint96 safeAmt, uint48 safeTime) = _safeCastClaim(takerOrder.claims[i], now48);
            schedules[sid] = ClaimSchedule({
                claimHash: takerOrder.claims[i].claimHash,
                token: makerOrder.sellToken,
                amount: safeAmt,
                releaseTime: safeTime,
                claimed: false,
                depositor: takerOrder.maker
            });
            scheduleIds[makerLen + i] = sid;
            ++sid;
        }

        scheduleCount = sid;

        emit Settled(matchId, makerOrder.maker, takerOrder.maker, scheduleIds);
    }

    // ─── Claim ───────────────────────────────────────────────────────
    function claimRelease(uint256 scheduleId, bytes32 secret) external nonReentrant {
        ClaimSchedule storage schedule = schedules[scheduleId];
        uint96 amt = schedule.amount;
        if (amt == 0) revert ScheduleNotFound();
        if (schedule.claimed) revert AlreadyClaimed();
        if (block.timestamp < schedule.releaseTime) revert NotYetReleasable();
        if (keccak256(abi.encodePacked(secret, msg.sender)) != schedule.claimHash) {
            revert InvalidSecretOrAddress();
        }

        schedule.claimed = true;
        IERC20(schedule.token).safeTransfer(msg.sender, amt);

        emit Claimed(scheduleId, msg.sender, schedule.token, amt);
    }

    // ─── Refund ──────────────────────────────────────────────────────
    function refundUnclaimed(uint256 scheduleId) external nonReentrant {
        ClaimSchedule storage schedule = schedules[scheduleId];
        uint96 amt = schedule.amount;
        if (amt == 0) revert ScheduleNotFound();
        if (schedule.claimed) revert AlreadyClaimed();
        if (block.timestamp < uint256(schedule.releaseTime) + REFUND_WINDOW) revert ClaimWindowNotExpired();
        if (msg.sender != schedule.depositor) revert NotDepositor();

        schedule.claimed = true;
        deposits[schedule.depositor][schedule.token] += amt;

        emit Refunded(scheduleId, schedule.depositor, amt);
    }

    // ─── Internal ────────────────────────────────────────────────────
    function _splitAndPayFee(address token, uint256 sellAmount, uint256 feeRate, address treasury) internal {
        uint256 totalFee = (sellAmount * feeRate) / FEE_DENOMINATOR;
        if (totalFee == 0) return;

        uint256 protocolCut = (totalFee * protocolFeeBps) / FEE_DENOMINATOR;
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
        uint256 actualFee
    ) internal view {
        // Verify not self-trade
        if (makerOrder.maker == takerOrder.maker) revert SelfTrade();

        // Verify signatures
        bytes32 makerHash = _hashOrder(makerOrder);
        bytes32 takerHash = _hashOrder(takerOrder);
        if (ECDSA.recover(makerHash, makerSig) != makerOrder.maker) revert InvalidSignature();
        if (ECDSA.recover(takerHash, takerSig) != takerOrder.maker) revert InvalidSignature();

        // Verify nonces
        if (nonces[makerOrder.maker][makerOrder.nonce]) revert NonceConsumed();
        if (nonces[takerOrder.maker][takerOrder.nonce]) revert NonceConsumed();

        // Verify expiry
        if (block.timestamp > makerOrder.expiry) revert OrderExpired();
        if (block.timestamp > takerOrder.expiry) revert OrderExpired();

        // Verify token compatibility
        if (makerOrder.sellToken != takerOrder.buyToken) revert TokenMismatch();
        if (makerOrder.buyToken != takerOrder.sellToken) revert TokenMismatch();

        // Verify price compatibility
        if (makerOrder.sellAmount * takerOrder.sellAmount > makerOrder.buyAmount * takerOrder.buyAmount) {
            revert PriceIncompatible();
        }

        // Verify fee
        if (actualFee > makerOrder.maxFee) revert FeeExceedsMax();
        if (actualFee > takerOrder.maxFee) revert FeeExceedsMax();

        // Verify claim counts
        uint256 makerClaimsLen = makerOrder.claims.length;
        uint256 takerClaimsLen = takerOrder.claims.length;
        if (makerClaimsLen == 0 || makerClaimsLen > MAX_CLAIMS_PER_ORDER) revert InvalidClaimCount();
        if (takerClaimsLen == 0 || takerClaimsLen > MAX_CLAIMS_PER_ORDER) revert InvalidClaimCount();

        // Verify claim amounts
        _verifyClaims(makerOrder.claims, takerOrder.sellAmount, actualFee);
        _verifyClaims(takerOrder.claims, makerOrder.sellAmount, actualFee);

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
