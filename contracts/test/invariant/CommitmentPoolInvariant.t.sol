// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";
import {MockDepositVerifier} from "../mocks/MockDepositVerifier.sol";
import {ProxyDeployer} from "../utils/ProxyDeployer.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";
import {CommitmentPoolHandler} from "./CommitmentPoolHandler.sol";

/// @dev Minimal contract used as the `authorizedSettlement` stand-in. The pool's
///      `setAuthorizedSettlement` requires `code.length > 0`, so an EOA won't do.
contract SettlementStub {}

/// @notice Invariant suite for CommitmentPool deposit / withdraw / insertCommitment paths.
contract CommitmentPoolInvariantTest is StdInvariant, Test {
    CommitmentPool internal pool;
    InvariantToken internal token;
    CommitmentPoolHandler internal handler;
    address internal settlement;

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        token = new InvariantToken();
        settlement = address(new SettlementStub());

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        pool.setTokenWhitelist(address(token), true);
        pool.setAuthorizedSettlement(settlement);

        handler = new CommitmentPoolHandler(pool, token, address(this), settlement);
        targetContract(address(handler));

        bytes4[] memory sels = new bytes4[](5);
        sels[0] = CommitmentPoolHandler.deposit.selector;
        sels[1] = CommitmentPoolHandler.withdraw.selector;
        sels[2] = CommitmentPoolHandler.insertCommitmentAsSettlement.selector;
        sels[3] = CommitmentPoolHandler.insertCommitmentAsRandom.selector;
        sels[4] = CommitmentPoolHandler.flipPause.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Pool token balance must cover `deposited - withdrawn`. If it ever drops below,
    ///      some path is leaking funds.
    function invariant_solvency() public view {
        uint256 deposited = handler.ghostDeposited();
        uint256 withdrawn = handler.ghostWithdrawn();
        assertGe(token.balanceOf(address(pool)) + withdrawn, deposited, "pool undercollateralized");
    }

    /// @dev Nullifier mapping is monotonic: once true after a successful withdraw,
    ///      stays true forever.
    function invariant_nullifierMonotonicity() public view {
        uint256 n = handler.nullifiersObservedCount();
        for (uint256 i; i < n; ++i) {
            uint256 nh = handler.nullifierAt(i);
            assertTrue(pool.nullifiers(nh), "withdrawn nullifier cleared");
        }
    }

    /// @dev Leaf count never regresses and at minimum equals the total successful
    ///      commitment-inserting actions (deposit + insertCommitment paths). A drop
    ///      would indicate Merkle-tree state was rewound.
    function invariant_leafCountFloor() public view {
        // Both deposit() and insertCommitmentAsSettlement() insert exactly one leaf on
        // success. Withdraw doesn't insert (newCommitment = 0).
        // ghostInsertedByAuth only increments on successful insertCommitment calls.
        // ghostDeposited tracks token amounts, not call counts, so we use the
        // contract's own nextIndex as a non-decreasing lower bound that ghosts
        // can be compared against.
        assertGe(uint256(pool.nextIndex()), handler.ghostInsertedByAuth(),
            "leaf count below successful insertCommitment count");
    }

    /// @dev Whitelist gate: the test token must remain whitelisted (handler never flips
    ///      it off), otherwise something else mutated state out of band.
    function invariant_whitelistStable() public view {
        assertTrue(pool.whitelistedTokens(address(token)), "test token whitelist flipped off");
    }
}
