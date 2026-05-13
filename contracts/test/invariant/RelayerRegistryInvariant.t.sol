// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {RelayerRegistry} from "../../src/RelayerRegistry.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";
import {RelayerRegistryHandler} from "./RelayerRegistryHandler.sol";

/// @notice Invariant suite for RelayerRegistry (ERC20 bond mode).
contract RelayerRegistryInvariantTest is StdInvariant, Test {
    RelayerRegistry internal registry;
    InvariantToken internal bondToken;
    MockIdentityRegistry internal identity;
    RelayerRegistryHandler internal handler;
    address internal constant TREASURY = address(0xBEEF);

    function setUp() public {
        bondToken = new InvariantToken();
        identity = new MockIdentityRegistry();
        registry = ProxyDeployer.deployRelayerRegistry(
            address(this), address(this), TREASURY, address(identity), address(bondToken)
        );
        handler = new RelayerRegistryHandler(registry, bondToken, identity, address(this));

        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](9);
        sels[0] = RelayerRegistryHandler.register.selector;
        sels[1] = RelayerRegistryHandler.addBond.selector;
        sels[2] = RelayerRegistryHandler.updateInfo.selector;
        sels[3] = RelayerRegistryHandler.requestExit.selector;
        sels[4] = RelayerRegistryHandler.executeExit.selector;
        sels[5] = RelayerRegistryHandler.setMinBond.selector;
        sels[6] = RelayerRegistryHandler.adversarialDoubleRegister.selector;
        sels[7] = RelayerRegistryHandler.adversarialEarlyExit.selector;
        sels[8] = RelayerRegistryHandler.adversarialUnauthorizedSetMinBond.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Bond token balance held by the registry must cover the sum of active bonds.
    function invariant_bondsCovered() public view {
        uint256 sum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            (,,, uint256 bond,, , bool active) = registry.relayers(handler.actorAt(i));
            if (active) sum += bond;
        }
        assertEq(sum, handler.ghostActiveBondSum(), "ghost vs on-chain active bond sum");
        assertGe(bondToken.balanceOf(address(registry)), sum, "registry undercollateralized");
    }

    /// @dev Active relayers must respect MAX_FEE and have non-zero registration timestamp.
    ///      Inactive relayers must have zero bond (exitRequestedAt is intentionally not cleared
    ///      by executeExit, so we don't assert on it).
    function invariant_feeAndStateBounds() public view {
        uint256 cap = registry.MAX_FEE();
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actorAt(i);
            (,, uint256 fee, uint256 bond, uint256 registeredAt,, bool active) = registry.relayers(a);
            if (active) {
                assertLe(fee, cap, "fee exceeds cap");
                assertGt(registeredAt, 0, "active without registeredAt");
            } else {
                assertEq(bond, 0, "inactive actor still has bond");
            }
        }
    }

    /// @dev relayerList grows monotonically — each address appears at most once.
    function invariant_relayerListUnique() public view {
        uint256 len = registry.getRelayerCount();
        for (uint256 i; i < len; ++i) {
            address ai = registry.relayerList(i);
            for (uint256 j = i + 1; j < len; ++j) {
                assertTrue(ai != registry.relayerList(j), "duplicate in relayerList");
            }
        }
    }

    /// @dev Coverage guard — see PR #718.
    function afterInvariant() public view {
        assertGt(handler.adversarialDoubleRegisterAttempts(), 0, "double-register never attempted");
        assertGt(handler.adversarialEarlyExitAttempts(), 0, "early-exit never attempted");
        assertGt(handler.adversarialUnauthorizedSetMinBondAttempts(), 0, "unauthorized setMinBond never attempted");
    }
}
