// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";

/// @notice Forks live Sepolia and rehearses the two admin-config proxy upgrades
///         (RelayerRegistry: bond token + exit cooldown; FeeVault: fee-change
///         delay) exactly as the deploy scripts will run them — new impl +
///         `upgradeAndCall(reinitializer)` from the real ProxyAdmin owner —
///         then asserts the new fields are initialized and pre-upgrade state is
///         preserved.
///
///  Gated on `SEPOLIA_RPC_URL`: without it the fork can't be created, so the
///  suite self-skips (every test no-ops). The contract name contains "Fork" so
///  CI's `--no-match-contract Fork` excludes it from the keyless run; execute
///  deliberately with:
///    SEPOLIA_RPC_URL=... forge test --match-contract SepoliaUpgradeFork -vv
contract SepoliaUpgradeForkTest is Test {
    address constant RELAYER_REGISTRY = 0x64fd8485793717fa3aBdb1FFc3406eC7fEee08fD;
    address constant FEE_VAULT = 0x49284b7d061570Ad089e75cf9b40De6D6282ffEC;

    bool internal active;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            return; // no RPC → self-skip
        }
        vm.createSelectFork(rpc);
        active = true;
    }

    function _proxyAdmin(address proxy) internal view returns (ProxyAdmin) {
        return ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));
    }

    function test_fork_relayerRegistry_upgrade_and_reinit() public {
        if (!active) return;
        RelayerRegistry reg = RelayerRegistry(payable(RELAYER_REGISTRY));

        // Snapshot pre-upgrade state.
        address ownerBefore = reg.owner();
        address treasuryBefore = reg.treasury();
        address bondTokenBefore = address(reg.bondToken());
        uint256 minBondBefore = reg.minBond();
        uint256 relayerCountBefore = reg.getRelayerCount();

        ProxyAdmin admin = _proxyAdmin(RELAYER_REGISTRY);

        // Perform the upgrade exactly like the script: new impl + reinitializeV2.
        RelayerRegistry newImpl = new RelayerRegistry();
        vm.prank(admin.owner());
        admin.upgradeAndCall(
            ITransparentUpgradeableProxy(RELAYER_REGISTRY),
            address(newImpl),
            abi.encodeCall(RelayerRegistry.reinitializeV2, ())
        );

        // New field initialized; pre-upgrade state preserved.
        assertEq(reg.exitCooldown(), reg.DEFAULT_EXIT_COOLDOWN(), "exitCooldown not initialized");
        assertEq(reg.owner(), ownerBefore, "owner changed");
        assertEq(reg.treasury(), treasuryBefore, "treasury changed");
        assertEq(address(reg.bondToken()), bondTokenBefore, "bondToken changed");
        assertEq(reg.minBond(), minBondBefore, "minBond changed");
        assertEq(reg.getRelayerCount(), relayerCountBefore, "relayer count changed");

        // The new owner-only setters work post-upgrade.
        vm.startPrank(ownerBefore);
        reg.setExitCooldown(3 days);
        assertEq(reg.exitCooldown(), 3 days);
        reg.setBondToken(address(0)); // native is always valid
        assertEq(address(reg.bondToken()), address(0));
        vm.stopPrank();

        // reinitializeV2 cannot be replayed.
        vm.expectRevert();
        reg.reinitializeV2();
    }

    function test_fork_feeVault_upgrade_and_reinit() public {
        if (!active) return;
        FeeVault vault = FeeVault(payable(FEE_VAULT));

        uint256 feeBefore = vault.platformFeeBps();
        address treasuryBefore = vault.treasury();
        address ownerBefore = vault.owner();

        ProxyAdmin admin = _proxyAdmin(FEE_VAULT);

        FeeVault newImpl = new FeeVault();
        vm.prank(admin.owner());
        admin.upgradeAndCall(
            ITransparentUpgradeableProxy(FEE_VAULT),
            address(newImpl),
            abi.encodeCall(FeeVault.reinitializeFeeChangeDelay, ())
        );

        // New field initialized to the default; pre-upgrade state preserved.
        assertEq(vault.feeChangeDelay(), vault.DEFAULT_FEE_CHANGE_DELAY(), "feeChangeDelay not initialized");
        assertEq(vault.platformFeeBps(), feeBefore, "platformFeeBps changed");
        assertEq(vault.treasury(), treasuryBefore, "treasury changed");
        assertEq(vault.owner(), ownerBefore, "owner changed");

        // Owner can tune the delay, and scheduleFeeChange picks it up.
        vm.startPrank(ownerBefore);
        vault.setFeeChangeDelay(2 days);
        assertEq(vault.feeChangeDelay(), 2 days);
        uint256 t0 = block.timestamp;
        vault.scheduleFeeChange(feeBefore == 0 ? 100 : 0);
        assertEq(vault.pendingFeeEffectiveTime(), t0 + 2 days, "schedule used wrong delay");
        vault.cancelFeeChange();
        vm.stopPrank();

        vm.expectRevert();
        vault.reinitializeFeeChangeDelay();
    }
}
