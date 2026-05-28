// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {SanctionsList} from "../../src/SanctionsList.sol";
import {IdentityGate} from "../../src/IdentityGate.sol";
import {RelayerRegistry} from "../../src/RelayerRegistry.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";

import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";
import {MockDepositVerifier} from "../mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "../mocks/MockClaimVerifier.sol";

import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {UpgradeHelper} from "./UpgradeHelper.sol";
import {
    FeeVaultV2,
    SanctionsListV2,
    IdentityGateV2,
    RelayerRegistryV2,
    CommitmentPoolV2,
    PrivateSettlementV2
} from "./V2Mocks.sol";

/// @notice Per-contract upgrade simulation: deploy V1 → mutate state → upgrade to V2 →
///         assert v1 state survived AND v2's new state is independently writable.
///         The state-preservation half is the load-bearing check — slot drift in V2
///         would corrupt inherited fields and surface immediately as a failed assert.
///         A separate `test_feeVault_upgradeAndCall_runsReinitializer` exercises the
///         `upgradeAndCall(impl, reinitData)` path (catches double-init, missing
///         `reinitializer` modifier, etc.) on FeeVault as a representative case.
contract UpgradeSimTest is Test {
    address admin = address(0xA0); // ProxyAdmin owner (upgrade authority)
    address owner = address(0xB0); // Contract owner

    // ─── FeeVault ────────────────────────────────────────────────

    function test_feeVault_upgrade_preservesStateAndAddsV2() public {
        address treasury = address(0xCAFE);
        FeeVault v1 = ProxyDeployer.deployFeeVault(admin, owner, treasury, 500);

        // Mutate v1 state from the owner.
        vm.startPrank(owner);
        v1.setAuthorizedDepositor(address(0xDEAD), true);
        vm.stopPrank();

        assertEq(v1.treasury(), treasury, "v1 treasury");
        assertEq(v1.platformFeeBps(), 500, "v1 fee bps");
        assertTrue(v1.authorizedDepositors(address(0xDEAD)), "v1 depositor");

        // Upgrade to V2.
        UpgradeHelper.upgrade(address(v1), address(new FeeVaultV2()), admin);
        FeeVaultV2 v2 = FeeVaultV2(payable(address(v1)));

        // V1 state survives.
        assertEq(v2.treasury(), treasury, "v2 treasury preserved");
        assertEq(v2.platformFeeBps(), 500, "v2 fee bps preserved");
        assertTrue(v2.authorizedDepositors(address(0xDEAD)), "v2 depositor preserved");
        assertEq(v2.owner(), owner, "v2 owner preserved");

        // V2 new state is independently writable.
        v2.v2_setCounter(42);
        assertEq(v2.v2_counter(), 42, "v2 new field");
    }

    function test_feeVault_upgradeAndCall_runsReinitializer() public {
        address treasury = address(0xCAFE);
        FeeVault v1 = ProxyDeployer.deployFeeVault(admin, owner, treasury, 500);

        // Upgrade + delegatecall `reinitializeV2(seed)` in one tx.
        UpgradeHelper.upgradeAndCall(
            address(v1),
            address(new FeeVaultV2()),
            admin,
            abi.encodeWithSelector(FeeVaultV2.reinitializeV2.selector, uint256(0xBEEF))
        );

        FeeVaultV2 v2 = FeeVaultV2(payable(address(v1)));
        // V1 state still there.
        assertEq(v2.treasury(), treasury, "v1 treasury preserved through reinit");
        assertEq(v2.platformFeeBps(), 500, "v1 fee bps preserved through reinit");
        // Reinit body actually ran.
        assertEq(v2.v2_counter(), 0xBEEF, "reinitializeV2 ran");

        // Calling it again must revert (reinitializer(2) is one-shot).
        vm.expectRevert();
        v2.reinitializeV2(1);
    }

    // ─── SanctionsList ───────────────────────────────────────────

    function test_sanctionsList_upgrade_preservesStateAndAddsV2() public {
        SanctionsList v1 = ProxyDeployer.deploySanctionsList(admin, owner);

        vm.prank(owner);
        v1.addSanction(address(0xBAD));
        assertTrue(v1.sanctioned(address(0xBAD)), "v1 sanction");

        UpgradeHelper.upgrade(address(v1), address(new SanctionsListV2()), admin);
        SanctionsListV2 v2 = SanctionsListV2(address(v1));

        assertTrue(v2.sanctioned(address(0xBAD)), "v2 sanction preserved");
        assertEq(v2.owner(), owner, "v2 owner preserved");

        v2.v2_setCounter(7);
        assertEq(v2.v2_counter(), 7, "v2 new field");
    }

    // ─── IdentityGate ────────────────────────────────────────────

    function test_identityGate_upgrade_preservesStateAndAddsV2() public {
        MockIdentityRegistry reg = new MockIdentityRegistry();
        IdentityGate v1 = ProxyDeployer.deployIdentityGate(admin, owner, address(reg));

        MockIdentityRegistry reg2 = new MockIdentityRegistry();
        vm.prank(owner);
        v1.addRegistry(address(reg2));

        assertEq(v1.getRegistryCount(), 2, "v1 registries");

        UpgradeHelper.upgrade(address(v1), address(new IdentityGateV2()), admin);
        IdentityGateV2 v2 = IdentityGateV2(address(v1));

        assertEq(v2.getRegistryCount(), 2, "v2 registries preserved");
        assertEq(address(v2.registries(0)), address(reg), "v2 registry0");
        assertEq(address(v2.registries(1)), address(reg2), "v2 registry1");
        assertEq(v2.owner(), owner, "v2 owner preserved");

        v2.v2_setCounter(11);
        assertEq(v2.v2_counter(), 11, "v2 new field");
    }

    // ─── RelayerRegistry ─────────────────────────────────────────

    function test_relayerRegistry_upgrade_preservesStateAndAddsV2() public {
        MockIdentityRegistry idReg = new MockIdentityRegistry();
        address treasury = address(0xCAFE);
        RelayerRegistry v1 = ProxyDeployer.deployRelayerRegistry(admin, owner, treasury, address(idReg), address(0));

        // Register a relayer (native bond mode).
        address relayer = address(0xA1);
        idReg.setVerified(relayer, true);
        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        v1.register{value: 0.1 ether}("http://r.example", "R-1", 30, 0);

        assertEq(v1.treasury(), treasury, "v1 treasury");
        assertTrue(v1.isActiveRelayer(relayer), "v1 active");

        UpgradeHelper.upgrade(address(v1), address(new RelayerRegistryV2()), admin);
        RelayerRegistryV2 v2 = RelayerRegistryV2(payable(address(v1)));

        assertEq(v2.treasury(), treasury, "v2 treasury preserved");
        assertTrue(v2.isActiveRelayer(relayer), "v2 relayer active");
        assertEq(address(v2.identityRegistry()), address(idReg), "v2 identityRegistry preserved");
        assertEq(v2.owner(), owner, "v2 owner preserved");

        v2.v2_setCounter(99);
        assertEq(v2.v2_counter(), 99, "v2 new field");
    }

    // ─── CommitmentPool ──────────────────────────────────────────

    function test_commitmentPool_upgrade_preservesStateAndAddsV2() public {
        MockVerifier wv = new MockVerifier();
        MockDepositVerifier dv = new MockDepositVerifier();
        CommitmentPool v1 = ProxyDeployer.deployCommitmentPool(admin, owner, address(wv), address(dv), 20, 30);

        vm.startPrank(owner);
        v1.setTokenWhitelist(address(0xCAFE), true);
        vm.stopPrank();

        assertEq(v1.levels(), 20, "v1 levels");
        assertEq(v1.ROOT_HISTORY_SIZE(), 30, "v1 ring");
        assertTrue(v1.whitelistedTokens(address(0xCAFE)), "v1 whitelist");

        UpgradeHelper.upgrade(address(v1), address(new CommitmentPoolV2()), admin);
        CommitmentPoolV2 v2 = CommitmentPoolV2(address(v1));

        assertEq(v2.levels(), 20, "v2 levels preserved");
        assertEq(v2.ROOT_HISTORY_SIZE(), 30, "v2 ring preserved");
        assertTrue(v2.whitelistedTokens(address(0xCAFE)), "v2 whitelist preserved");
        assertEq(address(v2.withdrawVerifier()), address(wv), "v2 withdrawVerifier preserved");
        assertEq(address(v2.depositVerifier()), address(dv), "v2 depositVerifier preserved");
        assertEq(v2.owner(), owner, "v2 owner preserved");

        v2.v2_setCounter(123);
        assertEq(v2.v2_counter(), 123, "v2 new field");
    }

    // ─── PrivateSettlement ───────────────────────────────────────

    function test_privateSettlement_upgrade_preservesStateAndAddsV2() public {
        MockVerifier wv = new MockVerifier();
        MockDepositVerifier dv = new MockDepositVerifier();
        MockClaimVerifier cv = new MockClaimVerifier();
        CommitmentPool pool = ProxyDeployer.deployCommitmentPool(admin, owner, address(wv), address(dv), 20, 30);
        address weth = address(0xBEEF);

        PrivateSettlement v1 = ProxyDeployer.deployPrivateSettlement(admin, owner, address(pool), address(cv), weth);

        vm.prank(owner);
        v1.setTokenWhitelist(address(0xCAFE), true);

        assertEq(v1.weth(), weth, "v1 weth");
        assertEq(address(v1.pool()), address(pool), "v1 pool");
        assertTrue(v1.whitelistedTokens(address(0xCAFE)), "v1 whitelist");

        UpgradeHelper.upgrade(address(v1), address(new PrivateSettlementV2()), admin);
        PrivateSettlementV2 v2 = PrivateSettlementV2(payable(address(v1)));

        assertEq(v2.weth(), weth, "v2 weth preserved");
        assertEq(address(v2.pool()), address(pool), "v2 pool preserved");
        assertTrue(v2.whitelistedTokens(address(0xCAFE)), "v2 whitelist preserved");
        assertEq(address(v2.claimVerifierByTier(16)), address(cv), "v2 tier16 verifier preserved");
        assertEq(v2.owner(), owner, "v2 owner preserved");

        v2.v2_setCounter(777);
        assertEq(v2.v2_counter(), 777, "v2 new field");
    }
}
