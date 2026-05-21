// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {MockCancelVerifier} from "../mocks/MockCancelVerifier.sol";

/// @notice Actor-based handler for PrivateSettlement.cancelPrivate invariant tests.
/// @dev    Drives fuzzed cancel sequences through a small set of escrow/nonce nullifier
///         pairs so the invariant runner can stress the three nullifier mappings and the
///         pool commitment-insertion path under arbitrary ordering and reverts.
contract PrivateSettlementCancelHandler is CommonBase, StdCheats, StdUtils {
    PrivateSettlement public immutable settlement;
    CommitmentPool public immutable pool;
    MockCancelVerifier public immutable cancelVerifier;
    address public immutable owner;

    uint256[2] internal proofA;
    uint256[2][2] internal proofB;
    uint256[2] internal proofC;

    bytes32[] public escrowKeys;
    bytes32[] public nonceKeys;

    /// @dev Track which keys have been observed `true` in the on-chain mapping so
    ///      invariant_nullifierMonotonicity can assert "once true → always true".
    mapping(bytes32 => bool) public ghostEscrowSeenTrue;
    mapping(bytes32 => bool) public ghostNonceSeenTrue;

    uint256 public ghostSuccessfulCancels;
    uint256 public ghostNextCommitmentSeed = 1;

    /// @dev Spent (escrow, nonce) pairs captured at successful cancel
    ///      time so the adversarial replay selector has real targets to
    ///      replay. Mapping alone (ghostEscrowSeenTrue) doesn't give us
    ///      an enumerable list.
    bytes32[] public spentEscrowKeys;
    bytes32[] public spentNonceKeys;

    /// @dev Selector-invocation counter for the adversarial path
    ///      (incremented at entry per PR #718).
    uint256 public adversarialReplayCancelAttempts;

    constructor(PrivateSettlement _settlement, CommitmentPool _pool, MockCancelVerifier _cancel, address _owner) {
        settlement = _settlement;
        pool = _pool;
        cancelVerifier = _cancel;
        owner = _owner;

        for (uint160 i = 1; i <= 8; ++i) {
            escrowKeys.push(bytes32(uint256(0xE000 + i)));
            nonceKeys.push(bytes32(uint256(0xF000 + i)));
        }
    }

    function _pickEscrow(uint256 seed) internal view returns (bytes32) {
        return escrowKeys[seed % escrowKeys.length];
    }

    function _pickNonce(uint256 seed) internal view returns (bytes32) {
        return nonceKeys[seed % nonceKeys.length];
    }

    /// @notice Fuzzed cancel attempt. Reverts (bad root, replay, same escrow=nonce, etc.)
    ///         are caught so the invariant runner can keep going and surface state drift.
    function cancel(uint256 escrowSeed, uint256 nonceSeed, bool useStaleRoot) external {
        bytes32 oldEscrow = _pickEscrow(escrowSeed);
        bytes32 oldNonce = _pickNonce(nonceSeed);

        bytes32 root = useStaleRoot
            ? bytes32(uint256(0xDEAD))  // deliberately unknown — will revert
            : bytes32(pool.getLastRoot());

        bytes32 newCommitment = bytes32(ghostNextCommitmentSeed++);

        PrivateSettlement.CancelParams memory p = PrivateSettlement.CancelParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            commitmentRoot: uint256(root),
            oldNullifier: oldEscrow,
            oldNonceNullifier: oldNonce,
            newCommitment: newCommitment
        });

        try settlement.cancelPrivate(p) {
            if (!ghostEscrowSeenTrue[oldEscrow]) {
                ghostEscrowSeenTrue[oldEscrow] = true;
                spentEscrowKeys.push(oldEscrow);
            }
            if (!ghostNonceSeenTrue[oldNonce]) {
                ghostNonceSeenTrue[oldNonce] = true;
                spentNonceKeys.push(oldNonce);
            }
            ghostSuccessfulCancels++;
        } catch {}
    }

    /// @notice Replay a previously-spent escrow nullifier in a cancel.
    ///         Must always revert with `NullifierAlreadySpent` — the
    ///         only guard between actors and double-cancel of the same
    ///         escrow. Counter increments at entry; we pick from the
    ///         spent set so the call actually exercises the replay
    ///         check (no escrows yet → skip).
    function adversarialReplayCancel(uint256 seed) external {
        adversarialReplayCancelAttempts += 1;
        if (spentEscrowKeys.length == 0) return;
        bytes32 spentEscrow = spentEscrowKeys[seed % spentEscrowKeys.length];
        bytes32 freshNonce = _pickNonce(seed >> 8);
        if (settlement.paused()) {
            vm.prank(owner);
            try settlement.unpause() {}
            catch {
                return;
            }
        }
        PrivateSettlement.CancelParams memory p = PrivateSettlement.CancelParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            commitmentRoot: pool.getLastRoot(),
            oldNullifier: spentEscrow,
            oldNonceNullifier: freshNonce,
            newCommitment: bytes32(ghostNextCommitmentSeed++)
        });
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.cancelPrivate(p);
    }

    /// @notice Toggle the verifier between accept/reject so revert paths get exercised.
    function flipVerifier(bool accept) external {
        cancelVerifier.setShouldPass(accept);
    }

    /// @notice Toggle pause so the whenNotPaused gate is exercised both ways.
    ///         Wrapped in try/catch because pause/unpause revert when already in target state.
    function flipPause(bool paused) external {
        vm.prank(owner);
        if (paused) try settlement.pause() {} catch {} else try settlement.unpause() {} catch {}
    }

    function escrowKeyCount() external view returns (uint256) {
        return escrowKeys.length;
    }

    function nonceKeyCount() external view returns (uint256) {
        return nonceKeys.length;
    }

    function escrowKeyAt(uint256 i) external view returns (bytes32) {
        return escrowKeys[i % escrowKeys.length];
    }

    function nonceKeyAt(uint256 i) external view returns (bytes32) {
        return nonceKeys[i % nonceKeys.length];
    }
}
