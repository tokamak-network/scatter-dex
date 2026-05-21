// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

/// @dev Drop-in IIdentityRegistry stand-in that marks everyone verified
///      forever. Lets us populate multiple IdentityGate slots without
///      needing the production zk-X509 wiring.
contract AlwaysVerified is IIdentityRegistry {
    bool private _paused;

    function setPaused(bool p) external {
        _paused = p;
    }

    function paused() external view override returns (bool) {
        return _paused;
    }

    function isVerified(address) external view override returns (bool) {
        return !_paused;
    }

    function verifiedUntil(address) external view override returns (uint64) {
        return type(uint64).max;
    }
}

/// @title TrackCBranchCoverage
/// @notice Targeted branch fills for FeeVault / IdentityGate / RelayerRegistry
///         that the dedicated suites don't exercise. Grouped to stay under
///         the per-PR review surface.
contract TrackCBranchCoverage is Test {
    address owner = address(this);
    address alice = address(0xA11CE);
    address treasury = address(0xCAFE);

    // ─── FeeVault: renounceOwnership disabled ───────────────────

    function test_feeVault_renounceOwnership_disabled() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        vm.expectRevert(FeeVault.RenounceOwnershipDisabled.selector);
        v.renounceOwnership();
    }

    // ─── IdentityGate: MAX_REGISTRIES guard ─────────────────────

    function test_identityGate_maxRegistries_reverts() public {
        IdentityGate gate = ProxyDeployer.deployIdentityGate(owner, owner, address(new AlwaysVerified()));
        // setUp added 1 registry; MAX_REGISTRIES = 10 → add 9 more, then fail.
        for (uint256 i = 0; i < 9; i++) {
            gate.addRegistry(address(new AlwaysVerified()));
        }
        assertEq(gate.getRegistryCount(), 10);
        // Create the new registry BEFORE expectRevert so the very next
        // call seen by the cheatcode is addRegistry itself, not the
        // AlwaysVerified constructor.
        address extra = address(new AlwaysVerified());
        vm.expectRevert(IdentityGate.TooManyRegistries.selector);
        gate.addRegistry(extra);
    }

    function test_identityGate_renounceOwnership_disabled() public {
        IdentityGate gate = ProxyDeployer.deployIdentityGate(owner, owner, address(new AlwaysVerified()));
        vm.expectRevert(IdentityGate.RenounceOwnershipDisabled.selector);
        gate.renounceOwnership();
    }

    function test_identityGate_initialize_zeroRegistry_reverts() public {
        // Direct deploy bypassing ProxyDeployer so we can hit the initializer guard.
        IdentityGate impl = new IdentityGate();
        bytes memory data = abi.encodeWithSelector(IdentityGate.initialize.selector, owner, address(0));
        vm.expectRevert(IdentityGate.RegistryAddressZero.selector);
        new TransparentLikeProxy(address(impl), data);
    }

    // ─── RelayerRegistry: view helpers + edge cases ─────────────

    function test_relayerRegistry_getSettlementInfo_inactive() public {
        RelayerRegistry reg = _deployRelayerRegistry();
        (bool active, uint256 fee, address tr) = reg.getSettlementInfo(alice);
        assertFalse(active);
        assertEq(fee, 0);
        assertEq(tr, treasury);
    }

    function test_relayerRegistry_getRelayerCount_initial() public {
        RelayerRegistry reg = _deployRelayerRegistry();
        assertEq(reg.getRelayerCount(), 0);
    }

    function test_relayerRegistry_getActiveRelayers_empty() public {
        RelayerRegistry reg = _deployRelayerRegistry();
        address[] memory actives = reg.getActiveRelayers();
        assertEq(actives.length, 0);
    }

    function _deployRelayerRegistry() internal returns (RelayerRegistry) {
        AlwaysVerified registry = new AlwaysVerified();
        return ProxyDeployer.deployRelayerRegistry(owner, owner, treasury, address(registry), address(0));
    }
}

/// @dev Minimal TransparentUpgradeableProxy shim — local copy so we can
///      trigger initializer reverts without dragging an OZ import in
///      from the production deploy path. The constructor calls `initialize`
///      through delegatecall and propagates the revert.
contract TransparentLikeProxy {
    constructor(address impl, bytes memory data) payable {
        (bool ok, bytes memory ret) = impl.delegatecall(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}
