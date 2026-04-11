// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title SanctionsList
/// @notice On-chain address blocklist for OFAC SDN and other sanctions compliance.
///         Owner can add/remove addresses. Integrates with CommitmentPool and
///         PrivateSettlement to block sanctioned addresses from depositing,
///         withdrawing, claiming, or settling.
///
/// @dev    Follows the Chainalysis SanctionsList interface pattern so it can
///         be replaced with the Chainalysis oracle (0x40C57923...) if desired.
///         The isSanctioned(address) view function is the integration point.
contract SanctionsList is Ownable2Step {
    mapping(address => bool) public sanctioned;

    event AddressSanctioned(address indexed addr);
    event AddressUnsanctioned(address indexed addr);
    event BatchSanctioned(address[] addrs);

    error ZeroAddress();
    error AlreadySanctioned();
    error NotSanctioned();
    error RenounceOwnershipDisabled();

    constructor() Ownable(msg.sender) {}

    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    /// @notice Check if an address is sanctioned.
    function isSanctioned(address addr) external view returns (bool) {
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
    function addSanctionsBatch(address[] calldata addrs) external onlyOwner {
        for (uint256 i = 0; i < addrs.length; i++) {
            if (addrs[i] != address(0) && !sanctioned[addrs[i]]) {
                sanctioned[addrs[i]] = true;
            }
        }
        emit BatchSanctioned(addrs);
    }
}
