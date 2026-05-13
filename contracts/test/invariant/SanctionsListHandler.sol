// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {SanctionsList} from "../../src/SanctionsList.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @notice Actor-based handler for SanctionsList invariant tests.
/// @dev    Routes fuzzed add/remove (single + batch) actions through the owner,
///         with a ghost mirror so the invariant runner can detect divergence
///         between the contract's `sanctioned` mapping and our expected set.
contract SanctionsListHandler is CommonBase, StdCheats, StdUtils {
    SanctionsList public immutable list;
    address public immutable owner;

    address[] public targets;
    mapping(address => bool) public ghostSanctioned;

    /// @dev Selector-invocation counters for adversarial paths (PR #718).
    uint256 public adversarialUnauthorizedAddAttempts;
    uint256 public adversarialUnauthorizedRemoveAttempts;

    constructor(SanctionsList _list, address _owner) {
        list = _list;
        owner = _owner;
        for (uint160 i = 1; i <= 10; ++i) {
            targets.push(address(uint160(0xD000 + i)));
        }
    }

    function _t(uint256 seed) internal view returns (address) {
        return targets[seed % targets.length];
    }

    function addSingle(uint256 seed) external {
        address a = _t(seed);
        vm.prank(owner);
        try list.addSanction(a) {
            ghostSanctioned[a] = true;
        } catch {}
    }

    function removeSingle(uint256 seed) external {
        address a = _t(seed);
        vm.prank(owner);
        try list.removeSanction(a) {
            ghostSanctioned[a] = false;
        } catch {}
    }

    function addBatch(uint256 seed1, uint256 seed2, uint256 seed3) external {
        address[] memory addrs = new address[](3);
        addrs[0] = _t(seed1);
        addrs[1] = _t(seed2);
        addrs[2] = _t(seed3);
        vm.prank(owner);
        try list.addSanctionsBatch(addrs) {
            for (uint256 i; i < 3; ++i) ghostSanctioned[addrs[i]] = true;
        } catch {}
    }

    function removeBatch(uint256 seed1, uint256 seed2, uint256 seed3) external {
        address[] memory addrs = new address[](3);
        addrs[0] = _t(seed1);
        addrs[1] = _t(seed2);
        addrs[2] = _t(seed3);
        vm.prank(owner);
        try list.removeSanctionsBatch(addrs) {
            for (uint256 i; i < 3; ++i) ghostSanctioned[addrs[i]] = false;
        } catch {}
    }

    function targetCount() external view returns (uint256) { return targets.length; }
    function targetAt(uint256 i) external view returns (address) { return targets[i % targets.length]; }

    // ─── Adversarial actions ────────────────────────────────────

    /// @notice Non-owner tries to add a sanction. Must revert with OZ's
    ///         `OwnableUnauthorizedAccount` — sanctions list integrity
    ///         is compliance-critical and onlyOwner is the gate.
    function adversarialUnauthorizedAdd(uint256 seed) external {
        adversarialUnauthorizedAddAttempts += 1;
        address eoa = address(uint160(0xD0E0 + uint160(seed % 16)));
        vm.prank(eoa);
        vm.expectRevert(abi.encodeWithSelector(
            OwnableUpgradeable.OwnableUnauthorizedAccount.selector, eoa
        ));
        list.addSanction(_t(seed));
    }

    /// @notice Non-owner tries to remove a sanction. Same lesson.
    function adversarialUnauthorizedRemove(uint256 seed) external {
        adversarialUnauthorizedRemoveAttempts += 1;
        address eoa = address(uint160(0xD0E0 + uint160(seed % 16)));
        vm.prank(eoa);
        vm.expectRevert(abi.encodeWithSelector(
            OwnableUpgradeable.OwnableUnauthorizedAccount.selector, eoa
        ));
        list.removeSanction(_t(seed));
    }
}
