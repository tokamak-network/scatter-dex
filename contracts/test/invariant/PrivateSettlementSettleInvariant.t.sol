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

        bytes4[] memory sels = new bytes4[](5);
        sels[0] = PrivateSettlementSettleHandler.settleAuth.selector;
        sels[1] = PrivateSettlementSettleHandler.settleWithDex.selector;
        sels[2] = PrivateSettlementSettleHandler.scatterDirectAuth.selector;
        sels[3] = PrivateSettlementSettleHandler.claim.selector;
        sels[4] = PrivateSettlementSettleHandler.flipPause.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev THE accounting invariant. For every registered ClaimsGroup,
    ///      `totalClaimed <= totalLocked` — claims never exceed the escrow
    ///      that the settlement actually holds for that group.
    function invariant_totalClaimedBoundedByLocked() public view {
        uint256 n = handler.knownClaimsRootsCount();
        for (uint256 i; i < n; ++i) {
            bytes32 root = handler.knownClaimsRoots(i);
            (uint128 locked, uint128 claimed,, ) = settlement.claimsGroups(root);
            assertLe(claimed, locked, "totalClaimed exceeded totalLocked");
        }
    }

    /// @dev On-chain ClaimsGroup matches the handler ghost — catches state
    ///      writes that diverge from what the handler observed succeeding.
    function invariant_claimsGroupMirror() public view {
        uint256 n = handler.knownClaimsRootsCount();
        for (uint256 i; i < n; ++i) {
            bytes32 root = handler.knownClaimsRoots(i);
            (uint128 locked, uint128 claimed, address token,) = settlement.claimsGroups(root);
            assertEq(locked, handler.ghostTotalLocked(root), "totalLocked drift");
            assertEq(claimed, handler.ghostTotalClaimed(root), "totalClaimed drift");
            assertEq(token, handler.ghostGroupToken(root), "group token drift");
        }
    }

    /// @dev Escrow + nonce nullifiers and claim nullifiers, once spent, never clear.
    function invariant_nullifierMonotonicity() public view {
        uint256 e = handler.observedEscrowNullifiersCount();
        for (uint256 i; i < e; ++i) {
            assertTrue(settlement.nullifiers(handler.observedEscrowNullifiers(i)), "escrow nullifier cleared");
        }
        uint256 nn = handler.observedNonceNullifiersCount();
        for (uint256 i; i < nn; ++i) {
            assertTrue(settlement.nonceNullifiers(handler.observedNonceNullifiers(i)), "nonce nullifier cleared");
        }
        uint256 c = handler.observedClaimNullifiersCount();
        for (uint256 i; i < c; ++i) {
            assertTrue(settlement.claimNullifiers(handler.observedClaimNullifiers(i)), "claim nullifier cleared");
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
        uint256 n = handler.knownClaimsRootsCount();
        for (uint256 i; i < n; ++i) {
            bytes32 root = handler.knownClaimsRoots(i);
            (uint128 locked, uint128 claimed, address token,) = settlement.claimsGroups(root);
            assertLe(claimed, locked, "totalClaimed exceeded totalLocked in coverage loop");
            uint256 remaining = uint256(locked) - uint256(claimed);
            if (token == address(tokenA)) owedA += remaining;
            else if (token == address(tokenB)) owedB += remaining;
        }
        assertGe(tokenA.balanceOf(address(settlement)), owedA, "settlement undercollateralized in tokenA");
        assertGe(tokenB.balanceOf(address(settlement)), owedB, "settlement undercollateralized in tokenB");
    }
}
