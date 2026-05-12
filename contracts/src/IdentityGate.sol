// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
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
contract IdentityGate is Initializable, Ownable2StepUpgradeable, IIdentityRegistry {
    IIdentityRegistry[] public registries;
    mapping(address => bool) public registryExists;

    /// @dev Reserved storage for future upgrades. Decrement when new state added.
    uint256[50] private __gap;

    event RegistryAdded(address indexed registry);
    event RegistryRemoved(address indexed registry);

    uint256 public constant MAX_REGISTRIES = 10;

    error RegistryAddressZero();
    error RegistryAlreadyAdded();
    error RegistryNotFound();
    error NoRegistries();
    error TooManyRegistries();
    error RenounceOwnershipDisabled();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address _initialRegistry) external initializer {
        // `__Ownable_init` already reverts with `OwnableInvalidOwner(0)` when
        // `initialOwner == 0`; we only guard the registry parameter so the
        // error name (`RegistryAddressZero`) actually matches the field.
        if (_initialRegistry == address(0)) revert RegistryAddressZero();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        registries.push(IIdentityRegistry(_initialRegistry));
        registryExists[_initialRegistry] = true;
        emit RegistryAdded(_initialRegistry);
    }

    /// @dev Disable renounceOwnership to prevent lockout.
    function renounceOwnership() public pure override(OwnableUpgradeable) {
        revert RenounceOwnershipDisabled();
    }

    // ─── Registry Management ─────────────────────────────────

    function addRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert RegistryAddressZero();
        if (registryExists[_registry]) revert RegistryAlreadyAdded();
        if (registries.length >= MAX_REGISTRIES) revert TooManyRegistries();
        registries.push(IIdentityRegistry(_registry));
        registryExists[_registry] = true;
        emit RegistryAdded(_registry);
    }

    function removeRegistry(address _registry) external onlyOwner {
        if (!registryExists[_registry]) revert RegistryNotFound();
        uint256 len = registries.length;
        if (len == 1) revert NoRegistries();

        // Swap-and-pop — find and remove from array
        for (uint256 i; i < len;) {
            if (address(registries[i]) == _registry) {
                registries[i] = registries[len - 1];
                registries.pop();
                registryExists[_registry] = false;
                emit RegistryRemoved(_registry);
                return;
            }
            unchecked { ++i; }
        }
        // Unreachable: `registryExists` guard above ensures the loop finds the entry.
        revert RegistryNotFound();
    }

    function getRegistryCount() external view returns (uint256) {
        return registries.length;
    }

    function getRegistries() external view returns (address[] memory) {
        uint256 len = registries.length;
        address[] memory addrs = new address[](len);
        for (uint256 i; i < len;) {
            addrs[i] = address(registries[i]);
            unchecked { ++i; }
        }
        return addrs;
    }

    // ─── IIdentityRegistry Implementation ────────────────────

    /// @notice Returns true if ANY registered CA has verified the user.
    /// @dev Skips registries that revert (e.g., misconfigured proxy) to prevent DoS.
    function isVerified(address user) external view override returns (bool) {
        uint256 len = registries.length;
        for (uint256 i; i < len;) {
            try registries[i].isVerified(user) returns (bool verified) {
                if (verified) return true;
            } catch {
                // skip reverting registry
            }
            unchecked { ++i; }
        }
        return false;
    }

    /// @notice Returns the latest expiry across all CAs (0 = unverified in all).
    /// @dev Skips registries that revert.
    function verifiedUntil(address user) external view override returns (uint64) {
        uint64 latest = 0;
        uint256 len = registries.length;
        for (uint256 i; i < len;) {
            try registries[i].verifiedUntil(user) returns (uint64 until) {
                if (until > latest) latest = until;
            } catch {}
            unchecked { ++i; }
        }
        return latest;
    }

    /// @notice Returns true if ANY registry is paused.
    /// @dev Conservative: if even one CA is paused, the gate signals caution.
    ///      Individual CA pause does not block verification via other CAs —
    ///      isVerified() handles this because paused registries return false.
    ///      Skips registries that revert.
    function paused() external view override returns (bool) {
        uint256 len = registries.length;
        for (uint256 i; i < len;) {
            try registries[i].paused() returns (bool isPaused) {
                if (isPaused) return true;
            } catch {}
            unchecked { ++i; }
        }
        return false;
    }
}
