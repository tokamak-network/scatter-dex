// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {RelayerRegistry} from "../../src/RelayerRegistry.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";

/// @notice Actor-based handler for RelayerRegistry invariant tests (ERC20 bond mode).
contract RelayerRegistryHandler is CommonBase, StdCheats, StdUtils {
    RelayerRegistry public immutable registry;
    InvariantToken public immutable bondToken;
    MockIdentityRegistry public immutable identity;
    address public immutable owner;

    address[] public actors;
    mapping(address => bool) public seen;

    uint256 public ghostActiveBondSum;

    constructor(RelayerRegistry _registry, InvariantToken _bondToken, MockIdentityRegistry _identity, address _owner) {
        registry = _registry;
        bondToken = _bondToken;
        identity = _identity;
        owner = _owner;

        for (uint160 i = 1; i <= 6; ++i) {
            address a = address(uint160(0xC000 + i));
            actors.push(a);
            _identity.setVerified(a, true);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function register(uint256 seed, uint256 fee, uint256 bond) external {
        address a = _actor(seed);
        (,,,, , , bool active) = registry.relayers(a);
        if (active) return;

        fee = bound(fee, 0, registry.MAX_FEE());
        bond = bound(bond, registry.minBond(), 1e22);
        bondToken.mint(a, bond);
        vm.prank(a);
        bondToken.approve(address(registry), bond);

        vm.prank(a);
        try registry.register("u", "n", fee, bond) {
            ghostActiveBondSum += bond;
            if (!seen[a]) seen[a] = true;
        } catch {}
    }

    function addBond(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        (,,,, , , bool active) = registry.relayers(a);
        if (!active) return;
        amount = bound(amount, 1, 1e22);
        bondToken.mint(a, amount);
        vm.prank(a);
        bondToken.approve(address(registry), amount);
        vm.prank(a);
        try registry.addBond(amount) {
            ghostActiveBondSum += amount;
        } catch {}
    }

    function updateInfo(uint256 seed, uint256 fee) external {
        address a = _actor(seed);
        fee = bound(fee, 0, registry.MAX_FEE());
        vm.prank(a);
        try registry.updateInfo("u2", "n2", fee) {} catch {}
    }

    function requestExit(uint256 seed) external {
        address a = _actor(seed);
        vm.prank(a);
        try registry.requestExit() {} catch {}
    }

    function executeExit(uint256 seed) external {
        address a = _actor(seed);
        (,,, uint256 bond,, uint256 exitAt, bool active) = registry.relayers(a);
        if (!active || exitAt == 0) return;
        uint256 ready = exitAt + registry.EXIT_COOLDOWN();
        if (block.timestamp < ready) vm.warp(ready);
        vm.prank(a);
        try registry.executeExit() {
            ghostActiveBondSum -= bond;
        } catch {}
    }

    function setMinBond(uint256 v) external {
        v = bound(v, 0, 1e21);
        vm.prank(owner);
        registry.setMinBond(v);
    }

    function actorAt(uint256 i) external view returns (address) { return actors[i % actors.length]; }
    function actorCount() external view returns (uint256) { return actors.length; }
}
