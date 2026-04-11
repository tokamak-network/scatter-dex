// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISanctionsList} from "./interfaces/ISanctionsList.sol";

/// @title SanctionsList
/// @notice On-chain address blocklist for OFAC SDN and other sanctions compliance.
/// @dev    Implements ISanctionsList so it can be swapped with the Chainalysis
///         oracle (0x40C57923...) or any other compatible blocklist.
contract SanctionsList is Ownable2Step, ISanctionsList {
    mapping(address => bool) public sanctioned;

    uint256 public constant MAX_BATCH_SIZE = 200;

    event AddressSanctioned(address indexed addr);
    event AddressUnsanctioned(address indexed addr);

    error ZeroAddress();
    error AlreadySanctioned();
    error NotSanctioned();
    error BatchTooLarge();
    error RenounceOwnershipDisabled();

    constructor() Ownable(msg.sender) {}

    function renounceOwnership() public pure override {
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
