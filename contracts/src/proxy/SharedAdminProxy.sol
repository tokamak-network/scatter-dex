// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @title SharedAdminProxy
 * @notice A transparent upgradeable proxy that is governed by a PRE-EXISTING,
 *         SHARED {ProxyAdmin} passed to its constructor — instead of deploying a
 *         fresh ProxyAdmin per proxy.
 *
 * @dev Why this exists: OpenZeppelin v5's `TransparentUpgradeableProxy`
 *      hardcodes `new ProxyAdmin(initialOwner)` in its constructor (see
 *      TransparentUpgradeableProxy.sol:80), so a system of N proxies ends up
 *      with N distinct ProxyAdmin contracts. This variant accepts the admin as
 *      a constructor argument so a SINGLE {ProxyAdmin} governs every proxy in a
 *      deployment: handing off upgrade rights for the whole system is then a
 *      single `transferOwnership` on that one ProxyAdmin.
 *
 *      The transparent-dispatch behaviour (`_fallback` + the admin-only
 *      `upgradeToAndCall` dispatch) is copied VERBATIM from OZ v5's
 *      TransparentUpgradeableProxy; only the constructor's admin wiring differs.
 *      Because the standard {ProxyAdmin.upgradeAndCall} calls
 *      `ITransparentUpgradeableProxy(proxy).upgradeToAndCall(impl, data)`, the
 *      stock OZ ProxyAdmin drives this proxy unchanged.
 *
 * IMPORTANT: `admin_` MUST be a {ProxyAdmin}-like contract, never an EOA. The
 *      transparent pattern routes every call FROM the admin into the upgrade
 *      path and reverts non-upgrade selectors, so an EOA admin could never call
 *      the implementation through the proxy and would be permanently locked out
 *      of all non-upgrade functions. (Same constraint as OZ's transparent proxy,
 *      where the admin is always the auto-deployed ProxyAdmin.)
 *
 * WARNING: Do NOT add external functions to this contract — a selector clash
 *      with {ITransparentUpgradeableProxy.upgradeToAndCall} would be resolved in
 *      favour of the new function and could brick upgradeability (same caveat as
 *      OZ's TransparentUpgradeableProxy).
 */
contract SharedAdminProxy is ERC1967Proxy {
    /// @dev Immutable admin (the shared {ProxyAdmin}) — no SLOAD per call, and
    ///      it can never be changed here (ownership is transferred on the
    ///      ProxyAdmin instead).
    address private immutable _admin;

    /// @dev The proxy caller is the admin and cannot fall through to the target.
    error ProxyDeniedAdminAccess();

    /// @dev `admin_` had no code — an EOA admin would be permanently locked out
    ///      of the implementation under the transparent pattern. Fail at deploy.
    error AdminNotAContract();

    /**
     * @param logic  the implementation contract
     * @param admin_ a pre-deployed {ProxyAdmin} (shared across all proxies)
     * @param data   optional initializer calldata, run against `logic`
     */
    constructor(address logic, address admin_, bytes memory data)
        payable
        ERC1967Proxy(logic, data)
    {
        // Defensive: the admin MUST be a contract (a ProxyAdmin). OZ's stock
        // proxy can't hit this because it deploys the ProxyAdmin itself; here the
        // admin is injected, so guard against an accidental EOA that would brick
        // every non-upgrade call.
        if (admin_.code.length == 0) revert AdminNotAContract();
        _admin = admin_;
        // Set the ERC-1967 admin slot + emit AdminChanged for tooling/indexers.
        ERC1967Utils.changeAdmin(admin_);
    }

    /// @dev Returns the admin of this proxy (the shared ProxyAdmin).
    function _proxyAdmin() internal view virtual returns (address) {
        return _admin;
    }

    /// @dev If the caller is the admin, only `upgradeToAndCall` is accepted;
    ///      everything else transparently forwards to the implementation.
    function _fallback() internal virtual override {
        if (msg.sender == _proxyAdmin()) {
            if (msg.sig != ITransparentUpgradeableProxy.upgradeToAndCall.selector) {
                revert ProxyDeniedAdminAccess();
            }
            (address newImplementation, bytes memory data) =
                abi.decode(msg.data[4:], (address, bytes));
            ERC1967Utils.upgradeToAndCall(newImplementation, data);
        } else {
            super._fallback();
        }
    }
}
