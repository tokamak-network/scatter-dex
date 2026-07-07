// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ISanctionsList} from "./interfaces/ISanctionsList.sol";

/// @title SanctionsList
/// @notice On-chain address blocklist for OFAC SDN and other sanctions compliance.
/// @dev    Implements ISanctionsList. Supports an optional external oracle
///         (e.g. Chainalysis SDN Oracle at 0x40C57923...) whose entries are
///         OR-combined with the self-managed list. Boundary contracts can
///         therefore subscribe to one address while owner-managed national
///         lists and a third-party global list both contribute coverage.
contract SanctionsList is Initializable, Ownable2StepUpgradeable, ISanctionsList {
    mapping(address => bool) public sanctioned;

    uint256 public constant MAX_BATCH_SIZE = 200;

    /// @notice Optional external blocklist consulted after the self-managed map.
    ///         Set to address(0) to disable. Result is OR-combined: an address
    ///         is treated as sanctioned if either list reports it.
    ISanctionsList public externalOracle;

    /// @dev Reserved storage for future upgrades. Decrement when new state added.
    uint256[49] private __gap;

    event AddressSanctioned(address indexed addr);
    event AddressUnsanctioned(address indexed addr);
    event ExternalOracleUpdated(address indexed previousOracle, address indexed newOracle);

    error ZeroAddress();
    error AlreadySanctioned();
    error NotSanctioned();
    error BatchTooLarge();
    error RenounceOwnershipDisabled();
    error OracleUnchanged();
    error NotAContract();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
    }

    function renounceOwnership() public pure override(OwnableUpgradeable) {
        revert RenounceOwnershipDisabled();
    }

    /// @notice Check if an address is sanctioned by either the self-managed
    ///         list or the external oracle (if configured).
    /// @dev    External oracle failures (revert / non-conforming return data)
    ///         are treated as `false` rather than propagated, so a
    ///         misbehaving oracle cannot DoS deposits / withdrawals /
    ///         claims. The self-managed map remains authoritative for
    ///         entries we explicitly added.
    function isSanctioned(address addr) external view override returns (bool) {
        if (sanctioned[addr]) return true;
        ISanctionsList oracle = externalOracle;
        if (address(oracle) == address(0)) return false;
        try oracle.isSanctioned(addr) returns (bool flagged) {
            return flagged;
        } catch {
            return false;
        }
    }

    /// @notice Point at an external blocklist (e.g. Chainalysis SDN Oracle).
    ///         Pass address(0) to disable the fallback. Non-zero values must
    ///         be deployed contract code — setting an EOA would silently
    ///         break the OR-combine path (ABI decode on empty return data).
    function setExternalOracle(address oracle) external onlyOwner {
        if (oracle != address(0) && oracle.code.length == 0) revert NotAContract();
        address prev = address(externalOracle);
        if (prev == oracle) revert OracleUnchanged();
        externalOracle = ISanctionsList(oracle);
        emit ExternalOracleUpdated(prev, oracle);
    }

    /// @notice Add a single address to the sanctions list.
    function addSanction(address addr) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();
        if (sanctioned[addr]) revert AlreadySanctioned();
        sanctioned[addr] = true;
        emit AddressSanctioned(addr);
    }

    /// @notice Remove a single address from the sanctions list.
    function removeSanction(address addr) external onlyOwner {
        if (!sanctioned[addr]) revert NotSanctioned();
        sanctioned[addr] = false;
        emit AddressUnsanctioned(addr);
    }

    /// @notice Batch-add addresses (e.g. OFAC SDN list update).
    ///         Silently skips zero addresses and duplicates for convenience.
    ///         Emits individual AddressSanctioned events only for newly added.
    function addSanctionsBatch(address[] calldata addrs) external onlyOwner {
        uint256 len = addrs.length;
        if (len > MAX_BATCH_SIZE) revert BatchTooLarge();
        for (uint256 i; i < len;) {
            address a = addrs[i];
            if (a != address(0) && !sanctioned[a]) {
                sanctioned[a] = true;
                emit AddressSanctioned(a);
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Batch-remove addresses (e.g. OFAC delisting).
    function removeSanctionsBatch(address[] calldata addrs) external onlyOwner {
        uint256 len = addrs.length;
        if (len > MAX_BATCH_SIZE) revert BatchTooLarge();
        for (uint256 i; i < len;) {
            address a = addrs[i];
            if (sanctioned[a]) {
                sanctioned[a] = false;
                emit AddressUnsanctioned(a);
            }
            unchecked {
                ++i;
            }
        }
    }
}
