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
///      state var (consuming one slot of the v1 `__gap`) plus a tiny
///      setter/getter. This is the smallest possible diff that lets the
///      test exercise both halves of the upgrade safety check:
///        (a) v1 state survives the upgrade unchanged
///        (b) v2 can read+write its new state on top of that
///      The new vars sit *right after* the v1 state and *before* the v1
///      `__gap`, exactly where a real follow-up upgrade would place them.
///      Each child reserves a slimmer `__gap2` so the layout still has
///      headroom for further upgrades.

contract FeeVaultV2 is FeeVault {
    uint256 public v2_counter;
    uint256[49] private __gap2;
    function v2_setCounter(uint256 c) external { v2_counter = c; }
}

contract SanctionsListV2 is SanctionsList {
    uint256 public v2_counter;
    uint256[49] private __gap2;
    function v2_setCounter(uint256 c) external { v2_counter = c; }
}

contract IdentityGateV2 is IdentityGate {
    uint256 public v2_counter;
    uint256[49] private __gap2;
    function v2_setCounter(uint256 c) external { v2_counter = c; }
}

contract RelayerRegistryV2 is RelayerRegistry {
    uint256 public v2_counter;
    uint256[49] private __gap2;
    function v2_setCounter(uint256 c) external { v2_counter = c; }
}

contract CommitmentPoolV2 is CommitmentPool {
    uint256 public v2_counter;
    uint256[49] private __gap2;
    function v2_setCounter(uint256 c) external { v2_counter = c; }
}

contract PrivateSettlementV2 is PrivateSettlement {
    uint256 public v2_counter;
    uint256[49] private __gap2;
    function v2_setCounter(uint256 c) external { v2_counter = c; }
}
