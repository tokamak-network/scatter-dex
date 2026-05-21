// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {FeeVault} from "../src/FeeVault.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

/// @notice Initializer invariants for the upgradeable FeeVault — catches
///         the two classic "uninitialised implementation" footguns:
///         (a) re-initializing a live proxy, and (b) initializing the
///         implementation contract directly (would otherwise let anyone
///         take ownership of the logic contract).
contract FeeVaultUpgradeableTest is Test {
    address treasury = address(0xCAFE);
    address owner = address(0xBEEF);

    function test_initialize_revertsOnSecondCall() public {
        FeeVault vault = ProxyDeployer.deployFeeVault(address(this), owner, treasury, 500);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(owner, treasury, 500);
    }

    function test_implementation_initialize_reverts() public {
        FeeVault impl = new FeeVault();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(owner, treasury, 500);
    }
}
