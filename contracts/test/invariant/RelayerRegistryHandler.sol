// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {RelayerRegistry} from "../../src/RelayerRegistry.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @notice Actor-based handler for RelayerRegistry invariant tests (ERC20 bond mode).
contract RelayerRegistryHandler is CommonBase, StdCheats, StdUtils {
    RelayerRegistry public immutable registry;
    InvariantToken public immutable bondToken; // token A (the deploy-time global)
    InvariantToken public immutable bondTokenB; // token B — owner can switch the global to this
    MockIdentityRegistry public immutable identity;
    address public immutable owner;

    address[] public actors;

    uint256 public ghostActiveBondSum; // total across tokens
    /// @dev Active-bond sum per bond token (key = token address). Each relayer's
    ///      bond is denominated in the token recorded at THEIR register time, so
    ///      this must be tracked per token to assert per-token collateralization.
    mapping(address => uint256) public ghostByToken;

    /// @dev Selector-invocation counters for adversarial / coverage paths. Read by
    ///      `afterInvariant` to prove the selectors stayed wired.
    uint256 public adversarialDoubleRegisterAttempts;
    uint256 public adversarialEarlyExitAttempts;
    uint256 public adversarialUnauthorizedSetMinBondAttempts;
    uint256 public setBondTokenAttempts;

    constructor(
        RelayerRegistry _registry,
        InvariantToken _bondToken,
        InvariantToken _bondTokenB,
        MockIdentityRegistry _identity,
        address _owner
    ) {
        registry = _registry;
        bondToken = _bondToken;
        bondTokenB = _bondTokenB;
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

    /// @dev Map a bond-token address to the concrete mock so we can mint/approve it.
    function _tok(address addr) internal view returns (InvariantToken) {
        return addr == address(bondTokenB) ? bondTokenB : bondToken;
    }

    function register(uint256 seed, uint256 fee, uint256 bond) external {
        address a = _actor(seed);
        (,,,,,, bool active,) = registry.relayers(a);
        if (active) return;

        fee = bound(fee, 0, registry.MAX_FEE());
        bond = bound(bond, registry.minBond(), 1e22);
        // Bond is pulled in the CURRENT global token; mint/approve that one.
        address gt = address(registry.bondToken());
        InvariantToken g = _tok(gt);
        g.mint(a, bond);
        vm.prank(a);
        g.approve(address(registry), bond);

        vm.prank(a);
        try registry.register("u", "n", fee, bond) {
            ghostActiveBondSum += bond;
            ghostByToken[gt] += bond;
        } catch {}
    }

    function addBond(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        (,,,,,, bool active, address tok) = registry.relayers(a);
        if (!active) return;
        amount = bound(amount, 1, 1e22);
        // Top up in the relayer's RECORDED token, not the live global.
        InvariantToken g = _tok(tok);
        g.mint(a, amount);
        vm.prank(a);
        g.approve(address(registry), amount);
        vm.prank(a);
        try registry.addBond(amount) {
            ghostActiveBondSum += amount;
            ghostByToken[tok] += amount;
        } catch {}
    }

    /// @notice Owner switches the global bond token between the two ERC20s.
    ///         Existing relayers keep their recorded token (verified by the
    ///         per-token `invariant_bondsCovered`); only new registrations
    ///         pick up the change.
    function setBondTokenAction(uint256 sel) external {
        setBondTokenAttempts += 1;
        address next = (sel % 2 == 0) ? address(bondToken) : address(bondTokenB);
        vm.prank(owner);
        registry.setBondToken(next);
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
        (,,, uint256 bond,, uint256 exitAt, bool active, address tok) = registry.relayers(a);
        if (!active || exitAt == 0) return;
        uint256 ready = exitAt + registry.exitCooldown();
        if (block.timestamp < ready) vm.warp(ready);
        vm.prank(a);
        try registry.executeExit() {
            ghostActiveBondSum -= bond;
            ghostByToken[tok] -= bond;
        } catch {}
    }

    function setMinBond(uint256 v) external {
        v = bound(v, 0, 1e21);
        vm.prank(owner);
        registry.setMinBond(v);
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i % actors.length];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ─── Adversarial actions ────────────────────────────────────

    /// @notice Try to register a relayer that's already active. Must
    ///         revert with `AlreadyRegistered` — duplicate registration
    ///         would inflate `activeRelayers[]` and break invariants
    ///         that count active set membership.
    ///
    ///         `register()` reverts on the `active` check
    ///         (RelayerRegistry.sol:126) BEFORE `_pullBond` does any
    ///         transferFrom, so no mint/approve setup is needed — and
    ///         skipping it keeps the bond token's totalSupply untouched
    ///         so adversarial calls can't perturb the `bondsCovered`
    ///         invariant.
    function adversarialDoubleRegister(uint256 seed) external {
        adversarialDoubleRegisterAttempts += 1;
        address a = _actor(seed);
        (,,,,,, bool active,) = registry.relayers(a);
        if (!active) return; // pre-registration is the normal path, not adversarial here
        vm.prank(a);
        vm.expectRevert(RelayerRegistry.AlreadyRegistered.selector);
        registry.register("u", "n", 0, registry.minBond());
    }

    /// @notice executeExit before the cooldown elapses must revert with
    ///         `CooldownNotPassed`. The normal `executeExit` handler
    ///         warps past cooldown; this one deliberately skips that
    ///         warp so we're sure the time gate isn't accidentally
    ///         removed.
    function adversarialEarlyExit(uint256 seed) external {
        adversarialEarlyExitAttempts += 1;
        address a = _actor(seed);
        (,,,,, uint256 exitAt, bool active,) = registry.relayers(a);
        if (!active || exitAt == 0) return;
        uint256 ready = exitAt + registry.exitCooldown();
        if (block.timestamp >= ready) return; // can't test early-exit if already ready
        vm.prank(a);
        vm.expectRevert(RelayerRegistry.CooldownNotPassed.selector);
        registry.executeExit();
    }

    /// @notice Non-owner calls setMinBond. Must revert with OZ's
    ///         `OwnableUnauthorizedAccount`. A regression that removed
    ///         `onlyOwner` would let any actor lower the bond floor and
    ///         spam-register relayers.
    function adversarialUnauthorizedSetMinBond(uint256 seed, uint256 v) external {
        adversarialUnauthorizedSetMinBondAttempts += 1;
        v = bound(v, 0, 1e21);
        address eoa = address(uint160(0xC0E0 + uint160(seed % 16))); // not an owner
        vm.prank(eoa);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, eoa));
        registry.setMinBond(v);
    }
}
