// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ISanctionsList} from "./interfaces/ISanctionsList.sol";

/// @title SanctionsList
/// @notice On-chain address blocklist for OFAC SDN and other sanctions compliance.
/// @dev    Implements ISanctionsList so it can be swapped with the Chainalysis
///         oracle (0x40C57923...) or any other compatible blocklist.
contract SanctionsList is Initializable, Ownable2StepUpgradeable, ISanctionsList {
    mapping(address => bool) public sanctioned;

    uint256 public constant MAX_BATCH_SIZE = 200;

    /// @dev Reserved storage for future upgrades. Decrement when new state added.
    uint256[50] private __gap;

    event AddressSanctioned(address indexed addr);
    event AddressUnsanctioned(address indexed addr);

    error ZeroAddress();
    error AlreadySanctioned();
    error NotSanctioned();
    error BatchTooLarge();
    error RenounceOwnershipDisabled();

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

    /// @notice Check if an address is sanctioned.
    function isSanctioned(address addr) external view override returns (bool) {
        return sanctioned[addr];
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
        if (addrs.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        for (uint256 i = 0; i < addrs.length; i++) {
            if (addrs[i] != address(0) && !sanctioned[addrs[i]]) {
                sanctioned[addrs[i]] = true;
                emit AddressSanctioned(addrs[i]);
            }
        }
    }

    /// @notice Batch-remove addresses (e.g. OFAC delisting).
    function removeSanctionsBatch(address[] calldata addrs) external onlyOwner {
        if (addrs.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        for (uint256 i = 0; i < addrs.length; i++) {
            if (sanctioned[addrs[i]]) {
                sanctioned[addrs[i]] = false;
                emit AddressUnsanctioned(addrs[i]);
            }
        }
    }
}
