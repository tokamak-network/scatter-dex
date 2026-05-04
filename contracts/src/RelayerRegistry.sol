// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @notice On-chain registry for ScatterDEX relayers.
/// @dev Relayers may optionally stake a bond to register (minBond configurable by owner, default 0).
///      Bond is returned after a cooldown on exit.
///
///      Bond token is configurable via `bondToken` (immutable):
///      - `address(0)` → **native mode** (e.g. TON on Tokamak L2): bond paid via `msg.value`.
///      - non-zero ERC20 → **token mode** (e.g. TON ERC20 on L1): bond pulled via
///        `transferFrom`; caller must `approve` first. `msg.value` MUST be 0.
///      Choosing immutable lets one codebase deploy to both networks while
///      making it impossible to "rug" existing bonds by switching tokens.
///
///      NOTE (L-3): No bond slashing mechanism — malicious relayers lose only gas on
///      failed settle() attempts. Consider adding slashing for repeated violations.
///      NOTE (L-4): getActiveRelayers() iterates the full relayerList. For very large
///      registries, off-chain indexing via events is recommended instead.
contract RelayerRegistry is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct Relayer {
        string url;
        // Operator-set display name — distinguishes co-running relayers
        // (e.g. "Relayer-A" / "Relayer-B" in the dev stack) without
        // forcing UIs to round-trip an off-chain `/api/info` probe just
        // to render a label.
        string name;
        uint256 fee; // basis points
        uint256 bond; // staked amount
        uint256 registeredAt;
        uint256 exitRequestedAt; // 0 = active, >0 = exiting
        bool active;
    }

    uint256 public minBond; // optional — 0 means no bond required
    uint256 public constant EXIT_COOLDOWN = 7 days;
    uint256 public constant MAX_FEE = 500; // 5% max relayer fee

    IIdentityRegistry public immutable identityRegistry;
    /// @notice Bond token. `address(0)` means native (msg.value) mode.
    IERC20 public immutable bondToken;
    address public treasury;

    mapping(address => Relayer) public relayers;
    mapping(address => bool) private inList; // tracks if address was ever added to relayerList
    address[] public relayerList;

    // ─── Events ──────────────────────────────────────────────────
    event RelayerRegistered(address indexed relayer, string url, string name, uint256 fee, uint256 bond);
    event RelayerUpdated(address indexed relayer, string url, string name, uint256 fee);
    event ExitRequested(address indexed relayer, uint256 exitAfter);
    event RelayerExited(address indexed relayer, uint256 bondReturned);
    event BondAdded(address indexed relayer, uint256 amount);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event MinBondUpdated(uint256 oldMinBond, uint256 newMinBond);

    // ─── Errors ──────────────────────────────────────────────────
    error AlreadyRegistered();
    error NotRegistered();
    error InsufficientBond();
    error ExitNotRequested();
    error CooldownNotPassed();
    error AlreadyExiting();
    error ZeroAddress();
    error RelayerNotActive();
    error BondTransferFailed();
    error FeeTooHigh();
    error NotVerified();
    error RenounceOwnershipDisabled();
    /// @dev ERC20 mode received native value, or native mode received non-zero `bondAmount`.
    error WrongPaymentMode();

    /// @dev Disable renounceOwnership to prevent accidental lockout of admin functions.
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    /// @dev Override to reject zero-address transfers, preserving the original contract's behavior.
    function transferOwnership(address newOwner) public override {
        if (newOwner == address(0)) revert ZeroAddress();
        super.transferOwnership(newOwner);
    }

    /// @param _bondToken ERC20 token address for bonds, or `address(0)` for native (msg.value) mode.
    constructor(address _treasury, address _identityRegistry, address _bondToken) Ownable(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_identityRegistry == address(0)) revert ZeroAddress();
        treasury = _treasury;
        identityRegistry = IIdentityRegistry(_identityRegistry);
        bondToken = IERC20(_bondToken); // address(0) → native mode
    }

    // ─── Registration ────────────────────────────────────────────

    /// @param bondAmount In ERC20 mode, the amount to pull via `transferFrom` (caller must `approve` first).
    ///                   In native mode, MUST be 0 — bond is taken from `msg.value`.
    function register(string calldata url, string calldata name, uint256 fee, uint256 bondAmount) external payable nonReentrant {
        if (relayers[msg.sender].active) revert AlreadyRegistered();
        if (fee > MAX_FEE) revert FeeTooHigh();
        if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();

        uint256 bond = _pullBond(bondAmount);
        if (bond < minBond) revert InsufficientBond();

        relayers[msg.sender] = Relayer({
            url: url,
            name: name,
            fee: fee,
            bond: bond,
            registeredAt: block.timestamp,
            exitRequestedAt: 0,
            active: true
        });

        // Only add to list if first-time registration (prevent duplicates on re-register)
        if (!inList[msg.sender]) {
            relayerList.push(msg.sender);
            inList[msg.sender] = true;
        }

        emit RelayerRegistered(msg.sender, url, name, fee, bond);
    }

    /// @param bondAmount In ERC20 mode, the amount to pull. In native mode, MUST be 0.
    /// @dev `nonReentrant` is required because `_pullBond` performs an external
    ///      `safeTransferFrom` in ERC20 mode; without the guard a malicious bond
    ///      token could re-enter `executeExit` (or another state mutator) mid-pull.
    function addBond(uint256 bondAmount) external payable nonReentrant {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();

        uint256 bond = _pullBond(bondAmount);
        if (bond == 0) revert InsufficientBond();
        r.bond += bond;

        emit BondAdded(msg.sender, bond);
    }

    function updateInfo(string calldata url, string calldata name, uint256 fee) external {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt > 0) revert AlreadyExiting();
        if (fee > MAX_FEE) revert FeeTooHigh();

        r.url = url;
        r.name = name;
        r.fee = fee;

        emit RelayerUpdated(msg.sender, url, name, fee);
    }

    // ─── Exit ────────────────────────────────────────────────────

    function requestExit() external {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt > 0) revert AlreadyExiting();

        r.exitRequestedAt = block.timestamp;

        emit ExitRequested(msg.sender, block.timestamp + EXIT_COOLDOWN);
    }

    function executeExit() external nonReentrant {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt == 0) revert ExitNotRequested();
        if (block.timestamp < r.exitRequestedAt + EXIT_COOLDOWN) revert CooldownNotPassed();

        uint256 bondToReturn = r.bond;
        r.active = false;
        r.bond = 0;

        _pushBond(msg.sender, bondToReturn);

        emit RelayerExited(msg.sender, bondToReturn);
    }

    // ─── Bond plumbing ───────────────────────────────────────────

    /// @dev Pull bond from caller. In native mode, returns `msg.value` (and `bondAmount`
    ///      MUST be 0 — supplying both is an API misuse). In ERC20 mode, transfers
    ///      `bondAmount` from caller via `safeTransferFrom` and returns the same value
    ///      (`msg.value` MUST be 0).
    function _pullBond(uint256 bondAmount) internal returns (uint256) {
        if (address(bondToken) == address(0)) {
            // Native mode
            if (bondAmount != 0) revert WrongPaymentMode();
            return msg.value;
        }
        // ERC20 mode
        if (msg.value != 0) revert WrongPaymentMode();
        if (bondAmount != 0) {
            bondToken.safeTransferFrom(msg.sender, address(this), bondAmount);
        }
        return bondAmount;
    }

    /// @dev Push bond back to recipient. Skips no-op transfers so a 0-bond exit is gas-efficient.
    function _pushBond(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (address(bondToken) == address(0)) {
            (bool sent,) = to.call{value: amount}("");
            if (!sent) revert BondTransferFailed();
        } else {
            bondToken.safeTransfer(to, amount);
        }
    }

    // ─── Views ───────────────────────────────────────────────────

    function getFee(address relayer) external view returns (uint256) {
        return relayers[relayer].fee;
    }

    function isActiveRelayer(address relayer) external view returns (bool) {
        Relayer storage r = relayers[relayer];
        return r.active && r.exitRequestedAt == 0;
    }

    /// @notice Single-call getter for settlement validation — avoids 3 separate external calls.
    function getSettlementInfo(address relayer) external view returns (bool isActive, uint256 fee, address treasury_) {
        Relayer storage r = relayers[relayer];
        return (r.active && r.exitRequestedAt == 0, r.fee, treasury);
    }

    function getRelayerCount() external view returns (uint256) {
        return relayerList.length;
    }

    function getActiveRelayers() external view returns (address[] memory) {
        uint256 count;
        for (uint256 i; i < relayerList.length; ++i) {
            Relayer storage r = relayers[relayerList[i]];
            if (r.active && r.exitRequestedAt == 0) ++count;
        }

        address[] memory active = new address[](count);
        uint256 idx;
        for (uint256 i; i < relayerList.length; ++i) {
            Relayer storage r = relayers[relayerList[i]];
            if (r.active && r.exitRequestedAt == 0) {
                active[idx++] = relayerList[i];
            }
        }
        return active;
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    /// @notice Set minimum bond required for relayer registration.
    /// @dev Set to 0 to make bond optional (align with patent: "optionally stake").
    function setMinBond(uint256 _minBond) external onlyOwner {
        emit MinBondUpdated(minBond, _minBond);
        minBond = _minBond;
    }

}
