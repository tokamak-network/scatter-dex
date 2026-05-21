// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {IdentityGate} from "../../src/IdentityGate.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @notice Actor-based handler for IdentityGate registry add/remove paths.
contract IdentityGateHandler is CommonBase, StdCheats, StdUtils {
    IdentityGate public immutable gate;
    address public immutable owner;

    /// @dev Pre-deployed pool of registries plus the seeded initial registry
    ///      so the fuzzer can target every entry the gate has ever known —
    ///      including the seeded one (otherwise `removeRegistry` can't reach
    ///      the "last remaining entry" revert branch).
    address[] public registryPool;

    /// @dev Selector-invocation counters for adversarial paths (see PR #718).
    uint256 public adversarialUnauthorizedAddAttempts;
    uint256 public adversarialUnauthorizedRemoveAttempts;

    constructor(IdentityGate _gate, address _owner) {
        gate = _gate;
        owner = _owner;
        // Seed the pool with the gate's initial registry (set at initialize()).
        registryPool.push(address(_gate.registries(0)));
        for (uint256 i; i < 12; ++i) {
            registryPool.push(address(new MockIdentityRegistry()));
        }
    }

    function _r(uint256 seed) internal view returns (address) {
        return registryPool[seed % registryPool.length];
    }

    function addRegistry(uint256 seed) external {
        address r = _r(seed);
        vm.prank(owner);
        try gate.addRegistry(r) {} catch {}
    }

    function removeRegistry(uint256 seed) external {
        address r = _r(seed);
        vm.prank(owner);
        try gate.removeRegistry(r) {} catch {}
    }

    function poolCount() external view returns (uint256) {
        return registryPool.length;
    }

    function poolAt(uint256 i) external view returns (address) {
        return registryPool[i % registryPool.length];
    }

    // ─── Adversarial actions ────────────────────────────────────

    /// @notice Non-owner tries to add a registry. Must revert with OZ's
    ///         `OwnableUnauthorizedAccount` — the gate's registry set
    ///         is the only thing standing between unverified wallets
    ///         and the settle path.
    function adversarialUnauthorizedAdd(uint256 seed) external {
        adversarialUnauthorizedAddAttempts += 1;
        address eoa = address(uint160(0xC0E0 + uint160(seed % 16)));
        vm.prank(eoa);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, eoa));
        gate.addRegistry(_r(seed));
    }

    /// @notice Non-owner tries to remove a registry. Same lesson.
    function adversarialUnauthorizedRemove(uint256 seed) external {
        adversarialUnauthorizedRemoveAttempts += 1;
        address eoa = address(uint160(0xC0E0 + uint160(seed % 16)));
        vm.prank(eoa);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, eoa));
        gate.removeRegistry(_r(seed));
    }
}
