// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FeeVault} from "../../src/FeeVault.sol";
import {SanctionsList} from "../../src/SanctionsList.sol";
import {IdentityGate} from "../../src/IdentityGate.sol";
import {RelayerRegistry} from "../../src/RelayerRegistry.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";

/// @dev V2 implementations used only by the upgrade-simulation tests.
///      Each one inherits the live v1 contract and appends a single new
///      state var (`v2_counter`) plus a tiny setter. This is the smallest
///      possible diff that exercises the property we actually want from
///      these tests: **v1 state survives the upgrade unchanged, and v2 can
///      read+write its own new state on top of that**.
///
///      Caveat (flagged by Copilot/Gemini on PR 7 review): because V2
///      *inherits* from V1, Solidity appends `v2_counter` AFTER the v1
///      `__gap` rather than placing it inside the gap. So these tests do
///      not directly verify gap-consumption semantics (a real follow-up
///      upgrade would re-declare the layout with a shrunken gap). They DO
///      verify the load-bearing property — slot drift / wrong layout
///      between v1 and v2 would corrupt the inherited state and the
///      "v1 state survives" asserts would fail. The gap-shrink invariant
///      is covered separately by `storage-layout check.sh` (CI step
///      landed in PR 6).

contract FeeVaultV2 is FeeVault {
    uint256 public v2_counter;
    uint256[49] private __gap2;

    function v2_setCounter(uint256 c) external {
        v2_counter = c;
    }

    /// @dev Re-runs on upgrade via `reinitializer(2)`. Lets the upgrade
    ///      test exercise the "init data on upgrade" path (catches missing
    ///      onlyInitializing modifiers, double-init, etc.).
    function reinitializeV2(uint256 seedCounter) external reinitializer(2) {
        v2_counter = seedCounter;
    }
}

contract SanctionsListV2 is SanctionsList {
    uint256 public v2_counter;
    uint256[49] private __gap2;

    function v2_setCounter(uint256 c) external {
        v2_counter = c;
    }
}

contract IdentityGateV2 is IdentityGate {
    uint256 public v2_counter;
    uint256[49] private __gap2;

    function v2_setCounter(uint256 c) external {
        v2_counter = c;
    }
}

contract RelayerRegistryV2 is RelayerRegistry {
    uint256 public v2_counter;
    uint256[49] private __gap2;

    function v2_setCounter(uint256 c) external {
        v2_counter = c;
    }
}

contract CommitmentPoolV2 is CommitmentPool {
    uint256 public v2_counter;
    uint256[49] private __gap2;

    function v2_setCounter(uint256 c) external {
        v2_counter = c;
    }
}

contract PrivateSettlementV2 is PrivateSettlement {
    uint256 public v2_counter;
    uint256[49] private __gap2;

    function v2_setCounter(uint256 c) external {
        v2_counter = c;
    }
}
