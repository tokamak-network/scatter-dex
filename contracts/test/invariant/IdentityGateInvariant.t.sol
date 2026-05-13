// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {IdentityGate} from "../../src/IdentityGate.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {IdentityGateHandler} from "./IdentityGateHandler.sol";

/// @notice Invariant suite for IdentityGate registry add/remove.
contract IdentityGateInvariantTest is StdInvariant, Test {
    IdentityGate internal gate;
    IdentityGateHandler internal handler;

    function setUp() public {
        // IdentityGate.initialize requires an initial registry, so seed with one.
        address seedRegistry = address(new MockIdentityRegistry());
        gate = ProxyDeployer.deployIdentityGate(address(this), address(this), seedRegistry);

        handler = new IdentityGateHandler(gate, address(this));
        targetContract(address(handler));

        bytes4[] memory sels = new bytes4[](4);
        sels[0] = IdentityGateHandler.addRegistry.selector;
        sels[1] = IdentityGateHandler.removeRegistry.selector;
        sels[2] = IdentityGateHandler.adversarialUnauthorizedAdd.selector;
        sels[3] = IdentityGateHandler.adversarialUnauthorizedRemove.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev MAX_REGISTRIES cap must never be exceeded.
    function invariant_registryCountBounded() public view {
        assertLe(gate.getRegistryCount(), gate.MAX_REGISTRIES(), "registry cap exceeded");
    }

    /// @dev `removeRegistry` reverts on the last entry (NoRegistries error), so
    ///      the gate must always have at least one registry wired.
    function invariant_atLeastOneRegistry() public view {
        assertGt(gate.getRegistryCount(), 0, "registry list empty");
    }

    /// @dev `registries` array contains no duplicates AND `registryExists` mirror
    ///      matches array membership exactly. Catches divergence in the swap-and-pop
    ///      bookkeeping or in `registryExists` flips.
    function invariant_registryUniquenessAndMirror() public view {
        uint256 len = gate.getRegistryCount();
        address[] memory list = gate.getRegistries();

        // Uniqueness within the array.
        for (uint256 i; i < len; ++i) {
            for (uint256 j = i + 1; j < len; ++j) {
                assertTrue(list[i] != list[j], "duplicate registry in array");
            }
        }

        // Mirror, forward direction: every entry actually in `registries[]` must
        // have `registryExists == true`. Catches "added to array but missed the flag".
        for (uint256 i; i < len; ++i) {
            assertTrue(gate.registryExists(list[i]), "array entry missing from registryExists");
        }

        // Mirror, reverse direction: for every candidate ever passed to the handler
        // (including the seeded registry), `registryExists` matches array membership.
        // Catches "flipped registryExists but didn't update array" (or vice versa).
        uint256 n = handler.poolCount();
        for (uint256 i; i < n; ++i) {
            address candidate = handler.poolAt(i);
            bool inArray = false;
            for (uint256 j; j < len; ++j) {
                if (list[j] == candidate) { inArray = true; break; }
            }
            assertEq(gate.registryExists(candidate), inArray,
                "registryExists out of sync with array");
        }
    }

    /// @dev Coverage guard — see PR #718.
    function afterInvariant() public view {
        assertGt(handler.adversarialUnauthorizedAddAttempts(), 0, "unauthorized add never attempted");
        assertGt(handler.adversarialUnauthorizedRemoveAttempts(), 0, "unauthorized remove never attempted");
    }
}
