// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";
import {MockDepositVerifier} from "../mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "../mocks/MockClaimVerifier.sol";
import {MockCancelVerifier} from "../mocks/MockCancelVerifier.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {PrivateSettlementCancelHandler} from "./PrivateSettlementCancelHandler.sol";

/// @notice Invariant suite focused on PrivateSettlement.cancelPrivate.
/// @dev    Asserts properties of the three nullifier mappings (escrow, nonce, claim)
///         and the pool commitment-insertion path under fuzzed cancel ordering.
contract PrivateSettlementCancelInvariantTest is StdInvariant, Test {
    PrivateSettlement internal settlement;
    CommitmentPool internal pool;
    MockCancelVerifier internal cancelVerifier;
    PrivateSettlementCancelHandler internal handler;

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        MockClaimVerifier claimVerifier = new MockClaimVerifier();
        cancelVerifier = new MockCancelVerifier();
        MockWETH weth = new MockWETH();

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier), address(weth)
        );
        pool.setAuthorizedSettlement(address(settlement));
        settlement.setCancelVerifier(address(cancelVerifier));

        handler = new PrivateSettlementCancelHandler(settlement, pool, cancelVerifier, address(this));
        targetContract(address(handler));

        bytes4[] memory sels = new bytes4[](3);
        sels[0] = PrivateSettlementCancelHandler.cancel.selector;
        sels[1] = PrivateSettlementCancelHandler.flipVerifier.selector;
        sels[2] = PrivateSettlementCancelHandler.flipPause.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Nullifier mappings are monotonic: once a key has been observed `true`
    ///      in the ghost mirror (recorded only after a successful cancelPrivate),
    ///      the on-chain mapping must still read `true` at every subsequent invariant tick.
    function invariant_nullifierMonotonicity() public view {
        uint256 n = handler.escrowKeyCount();
        for (uint256 i; i < n; ++i) {
            bytes32 ek = handler.escrowKeyAt(i);
            if (handler.ghostEscrowSeenTrue(ek)) {
                assertTrue(settlement.nullifiers(ek), "escrow nullifier cleared after spend");
            }
            bytes32 nk = handler.nonceKeyAt(i);
            if (handler.ghostNonceSeenTrue(nk)) {
                assertTrue(settlement.nonceNullifiers(nk), "nonce nullifier cleared after spend");
            }
        }
    }

    /// @dev cancelPrivate never touches claimNullifiers, so they must stay zero
    ///      throughout the run.
    function invariant_claimNullifiersUntouched() public view {
        uint256 n = handler.escrowKeyCount();
        for (uint256 i; i < n; ++i) {
            // Re-use escrow/nonce keys as probes — they're disjoint from any value
            // claimWithProof would set, but cancelPrivate must not leak into this map.
            assertFalse(settlement.claimNullifiers(handler.escrowKeyAt(i)), "claim mapping mutated by cancel path");
            assertFalse(settlement.claimNullifiers(handler.nonceKeyAt(i)), "claim mapping mutated by cancel path");
        }
    }

    /// @dev Every successful cancel inserts a new commitment, so the pool's known-root
    ///      count must be at least `ghostSuccessfulCancels` (plus the initial empty root).
    function invariant_rootGrowthMatchesCancels() public view {
        // `nextIndex` is the strict leaf count: starts at 0, increments by 1
        // per insertCommitment. Every successful cancelPrivate calls insertCommitment exactly once.
        assertGe(uint256(pool.nextIndex()), handler.ghostSuccessfulCancels(),
            "leaf count regressed below successful cancel count");
    }
}
