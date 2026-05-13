// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";
import {MockDepositVerifier} from "../mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "../mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "../mocks/MockAuthorizeVerifier.sol";
import {MockBatchAuthorizeVerifier} from "../mocks/MockBatchAuthorizeVerifier.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";
import {PrivateSettlementSettleHandler, InvariantDexRouter} from "./PrivateSettlementSettleHandler.sol";

/// @notice Invariant suite covering the three authorize-proof PrivateSettlement
///         entry points — settleAuth (half-proof), settleWithDex (single-party
///         DEX swap), and scatterDirectAuth (single-party same-token).
///         ScatterClaim already proves the same accounting surface on the
///         simpler withdraw-proof path; this suite closes the auth-proof gap
///         flagged as deferred in `docs/security/HARDENING.md`.
contract PrivateSettlementSettleInvariantTest is StdInvariant, Test {
    PrivateSettlement internal settlement;
    CommitmentPool internal pool;
    InvariantToken internal tokenA;
    InvariantToken internal tokenB;
    InvariantDexRouter internal dex;
    PrivateSettlementSettleHandler internal handler;

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        MockClaimVerifier claimVerifier = new MockClaimVerifier();
        MockAuthorizeVerifier authVerifier = new MockAuthorizeVerifier();
        MockBatchAuthorizeVerifier batchVerifier = new MockBatchAuthorizeVerifier();
        MockWETH weth = new MockWETH();
        tokenA = new InvariantToken();
        tokenB = new InvariantToken();

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier), address(weth)
        );

        pool.setTokenWhitelist(address(tokenA), true);
        pool.setTokenWhitelist(address(tokenB), true);
        pool.setAuthorizedSettlement(address(settlement));

        settlement.setTokenWhitelist(address(tokenA), true);
        settlement.setTokenWhitelist(address(tokenB), true);
        settlement.setAuthorizeVerifier(16, address(authVerifier));
        settlement.setBatchAuthorizeVerifier(16, address(batchVerifier));

        dex = new InvariantDexRouter();
        settlement.setDexRouterWhitelist(address(dex), true);

        handler = new PrivateSettlementSettleHandler(settlement, pool, tokenA, tokenB, dex, address(this));
        targetContract(address(handler));

        bytes4[] memory sels = new bytes4[](7);
        sels[0] = PrivateSettlementSettleHandler.settleAuth.selector;
        sels[1] = PrivateSettlementSettleHandler.settleWithDex.selector;
        sels[2] = PrivateSettlementSettleHandler.scatterDirectAuth.selector;
        sels[3] = PrivateSettlementSettleHandler.claim.selector;
        sels[4] = PrivateSettlementSettleHandler.flipPause.selector;
        sels[5] = PrivateSettlementSettleHandler.adversarialDoubleClaim.selector;
        sels[6] = PrivateSettlementSettleHandler.adversarialZeroAmountClaim.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev THE accounting invariant. For every registered ClaimsGroup,
    ///      `totalClaimed <= totalLocked` — claims never exceed the escrow
    ///      that the settlement actually holds for that group.
    function invariant_totalClaimedBoundedByLocked() public view {
        bytes32[] memory roots = handler.allKnownClaimsRoots();
        for (uint256 i; i < roots.length; ++i) {
            (uint128 locked, uint128 claimed,, ) = settlement.claimsGroups(roots[i]);
            assertLe(claimed, locked, "totalClaimed exceeded totalLocked");
        }
    }

    /// @dev On-chain ClaimsGroup matches the handler ghost — catches state
    ///      writes that diverge from what the handler observed succeeding.
    function invariant_claimsGroupMirror() public view {
        bytes32[] memory roots = handler.allKnownClaimsRoots();
        for (uint256 i; i < roots.length; ++i) {
            bytes32 root = roots[i];
            (uint128 locked, uint128 claimed, address token,) = settlement.claimsGroups(root);
            assertEq(locked, handler.ghostTotalLocked(root), "totalLocked drift");
            assertEq(claimed, handler.ghostTotalClaimed(root), "totalClaimed drift");
            assertEq(token, handler.ghostGroupToken(root), "group token drift");
        }
    }

    /// @dev Escrow + nonce nullifiers and claim nullifiers, once spent, never clear.
    function invariant_nullifierMonotonicity() public view {
        bytes32[] memory escrow = handler.allObservedEscrowNullifiers();
        for (uint256 i; i < escrow.length; ++i) {
            assertTrue(settlement.nullifiers(escrow[i]), "escrow nullifier cleared");
        }
        bytes32[] memory nonce = handler.allObservedNonceNullifiers();
        for (uint256 i; i < nonce.length; ++i) {
            assertTrue(settlement.nonceNullifiers(nonce[i]), "nonce nullifier cleared");
        }
        bytes32[] memory claimNulls = handler.allObservedClaimNullifiers();
        for (uint256 i; i < claimNulls.length; ++i) {
            assertTrue(settlement.claimNullifiers(claimNulls[i]), "claim nullifier cleared");
        }
    }

    /// @dev Per-token escrow coverage: for each token used by any registered
    ///      group, the settlement contract holds at least the un-claimed sum.
    ///      Catches "claim transferred funds out but didn't bump totalClaimed",
    ///      missing transferToSettlement on a register path, or cross-token
    ///      leakage between the two tokens.
    function invariant_settlementEscrowCoveredPerToken() public view {
        uint256 owedA;
        uint256 owedB;
        bytes32[] memory roots = handler.allKnownClaimsRoots();
        for (uint256 i; i < roots.length; ++i) {
            (uint128 locked, uint128 claimed, address token,) = settlement.claimsGroups(roots[i]);
            assertLe(claimed, locked, "totalClaimed exceeded totalLocked in coverage loop");
            uint256 remaining = uint256(locked) - uint256(claimed);
            if (token == address(tokenA)) owedA += remaining;
            else if (token == address(tokenB)) owedB += remaining;
        }
        assertGe(tokenA.balanceOf(address(settlement)), owedA, "settlement undercollateralized in tokenA");
        assertGe(tokenB.balanceOf(address(settlement)), owedB, "settlement undercollateralized in tokenB");
    }

    /// @dev Per-(recipient, token) balance matches the credit ledger. The
    ///      handler's recipient set (0xB201–0xB204) is fresh — nothing
    ///      else funds them, so on-chain balance == sum of every claim
    ///      credited to them in that token. Catches skim / lost transfer
    ///      / claim crediting the wrong recipient.
    function invariant_recipientLedgerExact() public view {
        for (uint160 i = 1; i <= 4; ++i) {
            address recipient = address(uint160(0xB200 + i));
            assertEq(
                tokenA.balanceOf(recipient),
                handler.ghostRecipientCredited(recipient, address(tokenA)),
                "recipient tokenA ledger drift"
            );
            assertEq(
                tokenB.balanceOf(recipient),
                handler.ghostRecipientCredited(recipient, address(tokenB)),
                "recipient tokenB ledger drift"
            );
        }
    }

    /// @dev Coverage guard: both adversarial selectors must have fired
    ///      during the campaign. See PR #718 for why this lives in
    ///      `afterInvariant` and not a `view` invariant.
    function afterInvariant() public view {
        assertGt(handler.adversarialDoubleClaimAttempts(), 0, "double-claim never attempted");
        assertGt(handler.adversarialZeroAmountClaimAttempts(), 0, "zero-amount claim never attempted");
    }
}
