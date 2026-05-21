// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {SettleVerifyLib} from "../../src/zk/SettleVerifyLib.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";
import {MockDepositVerifier} from "../mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "../mocks/MockClaimVerifier.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";
import {ScatterClaimHandler} from "./ScatterClaimHandler.sol";

/// @notice Invariant suite covering PrivateSettlement.scatterDirect +
///         claimWithProof — the simplest path that exercises the
///         ClaimsGroup accounting (totalLocked vs totalClaimed) end-to-end.
contract ScatterClaimInvariantTest is StdInvariant, Test {
    PrivateSettlement internal settlement;
    CommitmentPool internal pool;
    InvariantToken internal token;
    ScatterClaimHandler internal handler;

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        MockClaimVerifier claimVerifier = new MockClaimVerifier();
        MockWETH weth = new MockWETH();
        token = new InvariantToken();

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier), address(weth)
        );
        pool.setTokenWhitelist(address(token), true);
        pool.setAuthorizedSettlement(address(settlement));
        settlement.setTokenWhitelist(address(token), true);

        handler = new ScatterClaimHandler(settlement, pool, token, address(this));
        targetContract(address(handler));

        bytes4[] memory sels = new bytes4[](5);
        sels[0] = ScatterClaimHandler.scatter.selector;
        sels[1] = ScatterClaimHandler.claim.selector;
        sels[2] = ScatterClaimHandler.flipPause.selector;
        sels[3] = ScatterClaimHandler.adversarialDoubleClaim.selector;
        sels[4] = ScatterClaimHandler.adversarialZeroAmountClaim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev THE accounting invariant: for every registered ClaimsGroup,
    ///      `totalClaimed <= totalLocked`. Claims can never exceed the
    ///      amount the settlement actually holds in escrow for that group.
    function invariant_totalClaimedBoundedByLocked() public view {
        uint256 n = handler.knownClaimsRootsCount();
        for (uint256 i; i < n; ++i) {
            bytes32 root = handler.knownClaimsRoots(i);
            (uint128 locked, uint128 claimed,,) = settlement.claimsGroups(root);
            assertLe(claimed, locked, "totalClaimed exceeded totalLocked");
        }
    }

    /// @dev ClaimsGroup on-chain state matches the ghost mirror exactly. Catches
    ///      mismatches between what `scatterDirect`/`claimWithProof` wrote and
    ///      what the test harness believes happened.
    function invariant_claimsGroupMirror() public view {
        uint256 n = handler.knownClaimsRootsCount();
        for (uint256 i; i < n; ++i) {
            bytes32 root = handler.knownClaimsRoots(i);
            (uint128 locked, uint128 claimed,,) = settlement.claimsGroups(root);
            assertEq(locked, handler.ghostTotalLocked(root), "totalLocked drift");
            assertEq(claimed, handler.ghostTotalClaimed(root), "totalClaimed drift");
        }
    }

    /// @dev `claimNullifiers` is monotonic — once spent, always spent.
    function invariant_claimNullifierMonotonicity() public view {
        uint256 n = handler.observedClaimNullifiersCount();
        for (uint256 i; i < n; ++i) {
            bytes32 nullifier = handler.observedClaimNullifiers(i);
            assertTrue(settlement.claimNullifiers(nullifier), "claim nullifier cleared after spend");
        }
    }

    /// @dev Settlement's escrow holding for `token` must cover the un-claimed
    ///      portion across all known groups. Catches "claim transferred out
    ///      but didn't bump totalClaimed" (would shrink balance below cover).
    function invariant_settlementEscrowCovered() public view {
        uint256 owed;
        uint256 n = handler.knownClaimsRootsCount();
        for (uint256 i; i < n; ++i) {
            bytes32 root = handler.knownClaimsRoots(i);
            (uint128 locked, uint128 claimed,,) = settlement.claimsGroups(root);
            // Surface the real violation explicitly instead of letting the
            // subtraction underflow into a generic arithmetic revert.
            assertLe(claimed, locked, "totalClaimed exceeded totalLocked in coverage loop");
            owed += uint256(locked) - uint256(claimed);
        }
        assertGe(token.balanceOf(address(settlement)), owed, "settlement undercollateralized");
    }

    /// @dev Each recipient's on-chain ERC20 balance must equal the sum of
    ///      every successful claim credited to them. Catches: (a) the
    ///      transfer-out skimming part of the claim amount, (b) a claim
    ///      that bumped accounting without moving tokens, (c) a recipient
    ///      being credited by an external path that shouldn't exist.
    ///      Recipients in the handler set are fresh addresses (0xB101…
    ///      0xB105) — nothing else funds them, so balance == credited.
    function invariant_recipientLedgerExact() public view {
        for (uint160 i = 1; i <= 5; ++i) {
            address recipient = address(uint160(0xB100 + i));
            assertEq(token.balanceOf(recipient), handler.ghostRecipientCredited(recipient), "recipient ledger drift");
        }
    }

    /// @dev Sum of recipient balances equals `ghostTotalClaimedOut`.
    ///      Catches a claim that decremented one recipient while
    ///      crediting another, or any tokens leaking out of the
    ///      recipient set into a non-tracked address.
    function invariant_recipientSumMatchesClaimedOut() public view {
        uint256 sum;
        for (uint160 i = 1; i <= 5; ++i) {
            sum += token.balanceOf(address(uint160(0xB100 + i)));
        }
        assertEq(sum, handler.ghostTotalClaimedOut(), "recipient sum drift");
    }

    /// @dev Sanity: the adversarial actions must have actually fired
    ///      across the campaign. A green pass means "no double-claim
    ///      / no zero-amount slip" only if the handler actually tried;
    ///      a silently-zero attempt count would let a regression
    ///      (e.g. someone dropping the adversarial selectors from
    ///      `targetSelector`) hide behind early returns. Runs after
    ///      the fuzz campaign closes — Foundry's initial invariant
    ///      sweep at depth=0 would otherwise fail this with no calls
    ///      having fired yet.
    function afterInvariant() public view {
        assertGt(handler.adversarialDoubleClaimAttempts(), 0, "double-claim never attempted");
        assertGt(handler.adversarialZeroAmountClaimAttempts(), 0, "zero-amount claim never attempted");
    }
}
