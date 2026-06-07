// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IncrementalMerkleTree} from "../src/zk/IncrementalMerkleTree.sol";

/// @dev Minimal concrete subclass that exposes the `internal pure` zero/hash
///      helpers so the hardcoded zero constants can be checked against the live
///      Poseidon hash. No initialization is needed — both helpers are pure.
contract MerkleTreeHarness is IncrementalMerkleTree {
    function zeros(uint32 i) external pure returns (uint256) {
        return _zeros(i);
    }

    function hashPair(uint256 left, uint256 right) external pure returns (uint256) {
        return _hashPair(left, right);
    }
}

/// @title IncrementalMerkleTreeZerosTest
/// @notice Pins the hardcoded `_zeros(i)` constants to the actual Poseidon
///         hash chain (`zeros[0] = 0`, `zeros[i] = Poseidon(zeros[i-1],
///         zeros[i-1])`). A fat-fingered constant or a Poseidon library bump
///         that silently shifts the empty-subtree hashes would corrupt every
///         root computed by `_insert`; this test fails loudly if the committed
///         constants ever drift from what `_hashPair` actually produces.
contract IncrementalMerkleTreeZerosTest is Test {
    MerkleTreeHarness internal h;

    function setUp() public {
        h = new MerkleTreeHarness();
    }

    /// @dev levels are capped at 20, so `_insert` only ever reads `_zeros(0..19)`
    ///      (20 distinct empty-subtree values). Walk the full chain.
    function test_zeros_match_poseidon_chain() public view {
        assertEq(h.zeros(0), 0, "zeros[0] must be 0");

        uint256 expected = 0;
        for (uint32 i = 1; i < 20; i++) {
            // zeros[i] = Poseidon(zeros[i-1], zeros[i-1]) — anchored to the real
            // PoseidonT3 used by the tree (i=1 pins Poseidon(0,0)).
            expected = h.hashPair(expected, expected);
            assertEq(h.zeros(i), expected, "hardcoded zero constant drifted from Poseidon chain");
        }
    }

    /// @dev `_zeros` only defines levels 0..19; anything beyond is out of range.
    function test_zeros_out_of_range_reverts() public {
        vm.expectRevert(IncrementalMerkleTree.LevelOutOfRange.selector);
        h.zeros(20);
    }
}
