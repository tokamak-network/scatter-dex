// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @notice Multi-CA identity gate for zkScatter.
/// @dev Owner can add/remove zk-X509 IdentityRegistry instances (one per CA).
///      A user is considered verified if ANY registered CA has verified them.
///      Implements IIdentityRegistry interface so it can be used as a drop-in
///      replacement wherever a single registry is expected (e.g. RelayerRegistry).
///
///      Deploy two separate instances:
///        - User IdentityGate   (for CommitmentPool deposits)
///        - Relayer IdentityGate (for RelayerRegistry registration)
contract IdentityGate is Ownable2Step, IIdentityRegistry {
    IIdentityRegistry[] public registries;
    mapping(address => bool) public registryExists;

    event RegistryAdded(address indexed registry);
    event RegistryRemoved(address indexed registry);

    error RegistryAddressZero();
    error RegistryAlreadyAdded();
    error RegistryNotFound();
    error NoRegistries();
    error RenounceOwnershipDisabled();

    constructor(address _initialRegistry) Ownable(msg.sender) {
        if (_initialRegistry == address(0)) revert RegistryAddressZero();
        registries.push(IIdentityRegistry(_initialRegistry));
        registryExists[_initialRegistry] = true;
        emit RegistryAdded(_initialRegistry);
    }

    /// @dev Disable renounceOwnership to prevent lockout.
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    // ─── Registry Management ─────────────────────────────────

    function addRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert RegistryAddressZero();
        if (registryExists[_registry]) revert RegistryAlreadyAdded();
        registries.push(IIdentityRegistry(_registry));
        registryExists[_registry] = true;
        emit RegistryAdded(_registry);
    }

    function removeRegistry(address _registry) external onlyOwner {
        if (!registryExists[_registry]) revert RegistryNotFound();
        if (registries.length == 1) revert NoRegistries();

        // Swap-and-pop
        for (uint256 i = 0; i < registries.length; i++) {
            if (address(registries[i]) == _registry) {
                registries[i] = registries[registries.length - 1];
                registries.pop();
                break;
            }
        }
        registryExists[_registry] = false;
        emit RegistryRemoved(_registry);
    }

    function getRegistryCount() external view returns (uint256) {
        return registries.length;
    }

    function getRegistries() external view returns (address[] memory) {
        address[] memory addrs = new address[](registries.length);
        for (uint256 i = 0; i < registries.length; i++) {
            addrs[i] = address(registries[i]);
        }
        return addrs;
    }

    // ─── IIdentityRegistry Implementation ────────────────────

    /// @notice Returns true if ANY registered CA has verified the user.
    function isVerified(address user) external view override returns (bool) {
        for (uint256 i = 0; i < registries.length; i++) {
            if (registries[i].isVerified(user)) return true;
        }
        return false;
    }

    /// @notice Returns the latest expiry across all CAs (0 = unverified in all).
    function verifiedUntil(address user) external view override returns (uint64) {
        uint64 latest = 0;
        for (uint256 i = 0; i < registries.length; i++) {
            uint64 until = registries[i].verifiedUntil(user);
            if (until > latest) latest = until;
        }
        return latest;
    }

    /// @notice Returns true if ANY registry is paused.
    function paused() external view override returns (bool) {
        for (uint256 i = 0; i < registries.length; i++) {
            if (registries[i].paused()) return true;
        }
        return false;
    }
}
