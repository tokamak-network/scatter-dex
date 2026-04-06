// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @notice On-chain registry for ScatterDEX relayers.
/// @dev Relayers may optionally stake a bond to register (minBond configurable by owner, default 0).
///      Bond is returned after a cooldown on exit.
///      NOTE (L-3): No bond slashing mechanism — malicious relayers lose only gas on
///      failed settle() attempts. Consider adding slashing for repeated violations.
///      NOTE (L-4): getActiveRelayers() iterates the full relayerList. For very large
///      registries, off-chain indexing via events is recommended instead.
contract RelayerRegistry is Ownable2Step {
    struct Relayer {
        string url;
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
    address public treasury;

    mapping(address => Relayer) public relayers;
    mapping(address => bool) private inList; // tracks if address was ever added to relayerList
    address[] public relayerList;

    // ─── Events ──────────────────────────────────────────────────
    event RelayerRegistered(address indexed relayer, string url, uint256 fee, uint256 bond);
    event RelayerUpdated(address indexed relayer, string url, uint256 fee);
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

    /// @dev Disable renounceOwnership to prevent accidental lockout of admin functions.
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    /// @dev Override to reject zero-address transfers, preserving the original contract's behavior.
    function transferOwnership(address newOwner) public override {
        if (newOwner == address(0)) revert ZeroAddress();
        super.transferOwnership(newOwner);
    }

    constructor(address _treasury, address _identityRegistry) Ownable(msg.sender) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_identityRegistry == address(0)) revert ZeroAddress();
        treasury = _treasury;
        identityRegistry = IIdentityRegistry(_identityRegistry);
    }

    // ─── Registration ────────────────────────────────────────────

    function register(string calldata url, uint256 fee) external payable {
        if (relayers[msg.sender].active) revert AlreadyRegistered();
        if (msg.value < minBond) revert InsufficientBond();
        if (fee > MAX_FEE) revert FeeTooHigh();
        if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();

        relayers[msg.sender] = Relayer({
            url: url,
            fee: fee,
            bond: msg.value,
            registeredAt: block.timestamp,
            exitRequestedAt: 0,
            active: true
        });

        // Only add to list if first-time registration (prevent duplicates on re-register)
        if (!inList[msg.sender]) {
            relayerList.push(msg.sender);
            inList[msg.sender] = true;
        }

        emit RelayerRegistered(msg.sender, url, fee, msg.value);
    }

    function addBond() external payable {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();

        if (msg.value == 0) revert InsufficientBond();
        r.bond += msg.value;

        emit BondAdded(msg.sender, msg.value);
    }

    function updateInfo(string calldata url, uint256 fee) external {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt > 0) revert AlreadyExiting();
        if (fee > MAX_FEE) revert FeeTooHigh();

        r.url = url;
        r.fee = fee;

        emit RelayerUpdated(msg.sender, url, fee);
    }

    // ─── Exit ────────────────────────────────────────────────────

    function requestExit() external {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt > 0) revert AlreadyExiting();

        r.exitRequestedAt = block.timestamp;

        emit ExitRequested(msg.sender, block.timestamp + EXIT_COOLDOWN);
    }

    function executeExit() external {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt == 0) revert ExitNotRequested();
        if (block.timestamp < r.exitRequestedAt + EXIT_COOLDOWN) revert CooldownNotPassed();

        uint256 bondToReturn = r.bond;
        r.active = false;
        r.bond = 0;

        (bool sent,) = msg.sender.call{value: bondToReturn}("");
        if (!sent) revert BondTransferFailed();

        emit RelayerExited(msg.sender, bondToReturn);
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
