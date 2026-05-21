// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

/// @title MultiTierWiringTest
/// @notice Asserts the PrivateSettlement per-tier registries hold an
///         authorize + claim verifier for every tier the production
///         deploy script wires (16 / 64 / 128). Mirrors what
///         `script/DeployLocal.s.sol` does at deploy time, in a unit
///         test, so a regression in the deploy script (e.g. forgetting
///         to register a new tier) is caught before it reaches anvil.
///         Uses mock verifiers — the actual proof verification is
///         covered elsewhere (`SettleAuth.t.sol`).
contract MultiTierWiringTest is Test {
    PrivateSettlement settlement;
    MockAuthorizeVerifier authVerifier16;
    MockAuthorizeVerifier authVerifier64;
    MockAuthorizeVerifier authVerifier128;
    MockClaimVerifier claimVerifier16;
    MockClaimVerifier claimVerifier64;
    MockClaimVerifier claimVerifier128;

    function setUp() public {
        // Minimal pool + settlement deploy — we only care about the
        // per-tier verifier registries here, not pool flow.
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        MockWETH weth = new MockWETH();
        CommitmentPool pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        claimVerifier16 = new MockClaimVerifier();
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier16), address(weth)
        );

        authVerifier16 = new MockAuthorizeVerifier();
        authVerifier64 = new MockAuthorizeVerifier();
        authVerifier128 = new MockAuthorizeVerifier();
        claimVerifier64 = new MockClaimVerifier();
        claimVerifier128 = new MockClaimVerifier();

        // Same wiring as `_deployZkCore` in DeployLocal.s.sol —
        // registers all three live authorize tiers and the two
        // post-deploy claim tiers (tier 16 is seeded by the
        // PrivateSettlement constructor).
        settlement.setAuthorizeVerifier(16, address(authVerifier16));
        settlement.setAuthorizeVerifier(64, address(authVerifier64));
        settlement.setAuthorizeVerifier(128, address(authVerifier128));
        settlement.setClaimVerifier(64, address(claimVerifier64));
        settlement.setClaimVerifier(128, address(claimVerifier128));
    }

    function test_authorizeRegistryHasAllActiveTiers() public view {
        assertEq(address(settlement.authorizeVerifierByTier(16)), address(authVerifier16), "tier 16");
        assertEq(address(settlement.authorizeVerifierByTier(64)), address(authVerifier64), "tier 64");
        assertEq(address(settlement.authorizeVerifierByTier(128)), address(authVerifier128), "tier 128");
    }

    function test_claimRegistryHasAllActiveTiers() public view {
        assertEq(address(settlement.claimVerifierByTier(16)), address(claimVerifier16), "tier 16 (constructor-seeded)");
        assertEq(address(settlement.claimVerifierByTier(64)), address(claimVerifier64), "tier 64");
        assertEq(address(settlement.claimVerifierByTier(128)), address(claimVerifier128), "tier 128");
    }

    function test_unknownTierStillUnregistered() public view {
        // 32 isn't a planned tier — registry must report empty so
        // settleAuth would revert with TierNotConfigured(32) instead
        // of falling through to a neighbour tier's verifier.
        assertEq(address(settlement.authorizeVerifierByTier(32)), address(0), "authorize tier 32");
        assertEq(address(settlement.claimVerifierByTier(32)), address(0), "claim tier 32");
    }
}
