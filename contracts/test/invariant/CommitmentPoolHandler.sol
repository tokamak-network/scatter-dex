// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";

/// @notice Actor-based handler for CommitmentPool invariant tests.
/// @dev    Drives fuzzed deposit/withdraw/insertCommitment sequences with mock verifiers
///         (which always pass) so the runner exercises the pool's accounting + Merkle-tree
///         + nullifier mappings under arbitrary ordering and reverts.
contract CommitmentPoolHandler is CommonBase, StdCheats, StdUtils {
    CommitmentPool public immutable pool;
    InvariantToken public immutable token;
    address public immutable owner;
    address public immutable settlement;

    address[] public actors;

    uint[2] internal proofA;
    uint[2][2] internal proofB;
    uint[2] internal proofC;

    /// @dev Use safely-low leading nibble to stay below BN254 field modulus
    ///      (pool rejects commitments / amounts >= the modulus).
    uint256 internal constant FIELD_SAFE_MASK = (uint256(1) << 252) - 1;

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostInsertedByAuth;
    uint256 public ghostNextCommitment = 1;
    uint256 public ghostNextNullifier = 1;

    mapping(uint256 => bool) public ghostNullifierSeenTrue;
    uint256[] public observedNullifiers;

    constructor(CommitmentPool _pool, InvariantToken _token, address _owner, address _settlement) {
        pool = _pool;
        token = _token;
        owner = _owner;
        settlement = _settlement;

        for (uint160 i = 1; i <= 5; ++i) {
            actors.push(address(uint160(0xB000 + i)));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        amount = bound(amount, 1, 1e22);
        address a = _actor(actorSeed);
        uint256 commitment = (ghostNextCommitment++) & FIELD_SAFE_MASK;
        if (commitment == 0) commitment = 1;

        token.mint(a, amount);
        vm.prank(a);
        token.approve(address(pool), amount);

        vm.prank(a);
        try pool.deposit(proofA, proofB, proofC, commitment, address(token), amount) {
            ghostDeposited += amount;
        } catch {}
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        amount = bound(amount, 1, 1e20);
        address recipient = _actor(actorSeed);
        uint256 nullifier = (ghostNextNullifier++) & FIELD_SAFE_MASK;
        if (nullifier == 0) nullifier = 1;

        uint256 root = pool.getLastRoot();
        // Withdraw needs the pool to actually hold `amount`; skip otherwise.
        if (token.balanceOf(address(pool)) < amount) return;

        try pool.withdraw(
            proofA, proofB, proofC,
            root,
            nullifier,
            0, // newCommitment = 0 means no rotation
            address(token),
            amount,
            recipient,
            address(0)
        ) {
            ghostWithdrawn += amount;
            ghostNullifierSeenTrue[nullifier] = true;
            observedNullifiers.push(nullifier);
        } catch {}
    }

    function insertCommitmentAsSettlement() external {
        uint256 commitment = (ghostNextCommitment++) & FIELD_SAFE_MASK;
        if (commitment == 0) commitment = 1;
        vm.prank(settlement);
        try pool.insertCommitment(commitment) {
            ghostInsertedByAuth++;
        } catch {}
    }

    function insertCommitmentAsRandom(uint256 actorSeed) external {
        // Must revert — only authorizedSettlement can insert. If it ever
        // succeeds, the access-control invariant will flag the deviation.
        address a = _actor(actorSeed);
        vm.prank(a);
        try pool.insertCommitment(1) {
            // Should never reach here — invariant_insertCommitmentAccessControl
            // will detect this via the ghost-Inserted count drift.
            ghostInsertedByAuth++;
        } catch {}
    }

    function flipPause(bool paused) external {
        vm.prank(owner);
        if (paused) try pool.pause() {} catch {}
        else try pool.unpause() {} catch {}
    }

    function nullifiersObservedCount() external view returns (uint256) { return observedNullifiers.length; }
    function nullifierAt(uint256 i) external view returns (uint256) { return observedNullifiers[i]; }
}
