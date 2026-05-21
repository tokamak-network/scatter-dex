// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SanctionsList} from "../../src/SanctionsList.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {SanctionsListHandler} from "./SanctionsListHandler.sol";

/// @notice Invariant suite for SanctionsList add/remove (single + batch) paths.
contract SanctionsListInvariantTest is StdInvariant, Test {
    SanctionsList internal list;
    SanctionsListHandler internal handler;

    function setUp() public {
        list = ProxyDeployer.deploySanctionsList(address(this), address(this));
        handler = new SanctionsListHandler(list, address(this));
        targetContract(address(handler));

        bytes4[] memory sels = new bytes4[](6);
        sels[0] = SanctionsListHandler.addSingle.selector;
        sels[1] = SanctionsListHandler.removeSingle.selector;
        sels[2] = SanctionsListHandler.addBatch.selector;
        sels[3] = SanctionsListHandler.removeBatch.selector;
        sels[4] = SanctionsListHandler.adversarialUnauthorizedAdd.selector;
        sels[5] = SanctionsListHandler.adversarialUnauthorizedRemove.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Self-managed `sanctioned` mapping must match the handler's ghost mirror.
    ///      No external oracle is wired in this suite, so `isSanctioned` reduces to
    ///      a direct read of `sanctioned`.
    function invariant_sanctionedMirror() public view {
        uint256 n = handler.targetCount();
        for (uint256 i; i < n; ++i) {
            address t = handler.targetAt(i);
            assertEq(list.sanctioned(t), handler.ghostSanctioned(t), "sanctioned mapping diverged from ghost");
        }
    }

    /// @dev `isSanctioned(x)` must agree with the self-managed mapping when no
    ///      external oracle is wired (the OR-combine reduces to just `sanctioned`).
    function invariant_isSanctionedAgreesWithMap() public view {
        uint256 n = handler.targetCount();
        for (uint256 i; i < n; ++i) {
            address t = handler.targetAt(i);
            assertEq(
                list.isSanctioned(t),
                list.sanctioned(t),
                "isSanctioned diverged from sanctioned mapping (no oracle wired)"
            );
        }
    }

    /// @dev Coverage guard — see PR #718.
    function afterInvariant() public view {
        assertGt(handler.adversarialUnauthorizedAddAttempts(), 0, "unauthorized add never attempted");
        assertGt(handler.adversarialUnauthorizedRemoveAttempts(), 0, "unauthorized remove never attempted");
    }
}
