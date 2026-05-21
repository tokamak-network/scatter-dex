// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {FeeVaultHandler, InvariantToken} from "./FeeVaultHandler.sol";

/// @notice Invariant suite for FeeVault accounting.
/// @dev    Drives a fuzzed sequence of deposit/accrue/claim/withdraw actions
///         through `FeeVaultHandler` and asserts the vault's solvency and
///         book-keeping invariants after every call.
contract FeeVaultInvariantTest is StdInvariant, Test {
    FeeVault internal vault;
    InvariantToken internal token;
    FeeVaultHandler internal handler;
    address internal constant TREASURY = address(0xBEEF);

    function setUp() public {
        vault = ProxyDeployer.deployFeeVault(address(this), address(this), TREASURY, 500); // 5%
        token = new InvariantToken();
        handler = new FeeVaultHandler(vault, token, address(this), TREASURY);

        // Restrict invariant calls to handler entrypoints (avoid direct admin/etc.).
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](9);
        sels[0] = FeeVaultHandler.deposit.selector;
        sels[1] = FeeVaultHandler.accrueDexFee.selector;
        sels[2] = FeeVaultHandler.claim.selector;
        sels[3] = FeeVaultHandler.withdrawPlatformRevenue.selector;
        sels[4] = FeeVaultHandler.scheduleFeeChange.selector;
        sels[5] = FeeVaultHandler.applyFeeChange.selector;
        sels[6] = FeeVaultHandler.adversarialUnauthorizedDeposit.selector;
        sels[7] = FeeVaultHandler.adversarialEmptyClaim.selector;
        sels[8] = FeeVaultHandler.adversarialUnauthorizedWithdraw.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Vault token balance must always cover tracked liabilities + platform revenue.
    function invariant_solvency() public view {
        uint256 bal = token.balanceOf(address(vault));
        assertGe(
            bal, vault.totalTracked(address(token)) + vault.platformRevenue(address(token)), "vault undercollateralized"
        );
    }

    /// @dev `totalTracked` must equal the sum of per-relayer balances (ghost mirror).
    function invariant_totalTrackedEqualsSumOfBalances() public view {
        uint256 sum;
        uint256 n = handler.relayerCount();
        for (uint256 i; i < n; ++i) {
            address r = handler.relayerAt(i);
            uint256 onChain = vault.balances(r, address(token));
            assertEq(onChain, handler.ghostBalance(r), "balance/ghost mismatch");
            sum += onChain;
        }
        assertEq(sum, vault.totalTracked(address(token)), "totalTracked drift");
    }

    /// @dev Platform revenue mirror must match on-chain bucket between calls.
    function invariant_platformRevenueMirror() public view {
        assertEq(vault.platformRevenue(address(token)), handler.ghostPlatformRevenue(), "platformRevenue drift");
    }

    /// @dev Every platform fee skimmed during `claim` and every `withdrawPlatformRevenue`
    ///      lands at `treasury`. Since the handler never mints directly to treasury,
    ///      `token.balanceOf(treasury)` must match the cumulative ghost counter.
    function invariant_treasuryReceipts() public view {
        assertEq(token.balanceOf(TREASURY), handler.ghostTreasuryReceived(), "treasury balance / ghost mismatch");
    }

    /// @dev Fee bps configuration must stay within the documented cap at all times.
    function invariant_feeBpsBounded() public view {
        uint256 cap = vault.MAX_PLATFORM_FEE();
        assertLe(vault.platformFeeBps(), cap, "active fee > cap");
        assertLe(vault.pendingFeeBps(), cap, "pending fee > cap");
    }

    /// @dev Coverage guard: the three adversarial selectors must have
    ///      actually fired during the campaign. Runs after the fuzz
    ///      campaign closes (Foundry's depth-0 sweep would otherwise
    ///      fail any `> 0` assertion before any call landed). Same
    ///      pattern + lesson as PR #718.
    function afterInvariant() public view {
        assertGt(handler.adversarialUnauthorizedDepositAttempts(), 0, "unauthorized deposit never attempted");
        assertGt(handler.adversarialEmptyClaimAttempts(), 0, "empty claim never attempted");
        assertGt(handler.adversarialUnauthorizedWithdrawAttempts(), 0, "unauthorized withdraw never attempted");
    }
}
