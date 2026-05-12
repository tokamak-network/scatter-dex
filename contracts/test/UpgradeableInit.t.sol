// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {SanctionsList} from "../src/SanctionsList.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

/// @notice Initializer invariants for the upgradeable contracts converted in
///         this PR. Each contract gets two checks:
///         (a) calling `initialize()` again on a live proxy reverts, and
///         (b) the implementation contract's `initialize()` reverts directly.
contract UpgradeableInitTest is Test {
    address owner = address(0xBEEF);

    function test_sanctionsList_proxy_reinit_reverts() public {
        SanctionsList s = ProxyDeployer.deploySanctionsList(address(this), owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        s.initialize(owner);
    }

    function test_sanctionsList_impl_init_reverts() public {
        SanctionsList impl = new SanctionsList();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(owner);
    }

    function test_identityGate_proxy_reinit_reverts() public {
        MockIdentityRegistry reg = new MockIdentityRegistry();
        IdentityGate g = ProxyDeployer.deployIdentityGate(address(this), owner, address(reg));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        g.initialize(owner, address(reg));
    }

    function test_identityGate_impl_init_reverts() public {
        IdentityGate impl = new IdentityGate();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(owner, address(0xDEAD));
    }

    function test_relayerRegistry_proxy_reinit_reverts() public {
        MockIdentityRegistry reg = new MockIdentityRegistry();
        RelayerRegistry r = ProxyDeployer.deployRelayerRegistry(
            address(this), owner, address(0xCAFE), address(reg), address(0)
        );
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        r.initialize(owner, address(0xCAFE), address(reg), address(0));
    }

    function test_relayerRegistry_impl_init_reverts() public {
        RelayerRegistry impl = new RelayerRegistry();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(owner, address(0xCAFE), address(0xDEAD), address(0));
    }

    function test_commitmentPool_proxy_reinit_reverts() public {
        MockVerifier wv = new MockVerifier();
        MockDepositVerifier dv = new MockDepositVerifier();
        CommitmentPool p = ProxyDeployer.deployCommitmentPool(
            address(this), owner, address(wv), address(dv), 20, 30
        );
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        p.initialize(owner, address(wv), address(dv), 20, 30);
    }

    function test_commitmentPool_impl_init_reverts() public {
        MockVerifier wv = new MockVerifier();
        MockDepositVerifier dv = new MockDepositVerifier();
        CommitmentPool impl = new CommitmentPool();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(owner, address(wv), address(dv), 20, 30);
    }
}
