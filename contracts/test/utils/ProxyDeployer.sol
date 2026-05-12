// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {SanctionsList} from "../../src/SanctionsList.sol";
import {IdentityGate} from "../../src/IdentityGate.sol";
import {RelayerRegistry} from "../../src/RelayerRegistry.sol";

/// @dev Centralised proxy boilerplate for upgradeable contracts under test.
///      Deploys a fresh implementation + TransparentUpgradeableProxy and
///      returns the proxy address cast to the contract type.
///      `proxyAdminOwner` becomes the owner of the auto-created ProxyAdmin
///      (the proxy's upgrade authority); `initialOwner` becomes the contract owner.
library ProxyDeployer {
    function deployFeeVault(address proxyAdminOwner, address initialOwner, address treasury, uint256 platformFeeBps)
        internal
        returns (FeeVault)
    {
        FeeVault impl = new FeeVault();
        bytes memory initData = abi.encodeCall(FeeVault.initialize, (initialOwner, treasury, platformFeeBps));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), proxyAdminOwner, initData);
        return FeeVault(address(proxy));
    }

    function deploySanctionsList(address proxyAdminOwner, address initialOwner) internal returns (SanctionsList) {
        SanctionsList impl = new SanctionsList();
        bytes memory initData = abi.encodeCall(SanctionsList.initialize, (initialOwner));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), proxyAdminOwner, initData);
        return SanctionsList(address(proxy));
    }

    function deployIdentityGate(address proxyAdminOwner, address initialOwner, address initialRegistry)
        internal
        returns (IdentityGate)
    {
        IdentityGate impl = new IdentityGate();
        bytes memory initData = abi.encodeCall(IdentityGate.initialize, (initialOwner, initialRegistry));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), proxyAdminOwner, initData);
        return IdentityGate(address(proxy));
    }

    function deployRelayerRegistry(
        address proxyAdminOwner,
        address initialOwner,
        address treasury,
        address identityRegistry,
        address bondToken
    ) internal returns (RelayerRegistry) {
        RelayerRegistry impl = new RelayerRegistry();
        bytes memory initData =
            abi.encodeCall(RelayerRegistry.initialize, (initialOwner, treasury, identityRegistry, bondToken));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), proxyAdminOwner, initData);
        return RelayerRegistry(payable(address(proxy)));
    }
}
