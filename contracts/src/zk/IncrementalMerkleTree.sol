// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

/// @title IncrementalMerkleTree
/// @notice Append-only Merkle tree using Poseidon hash, with a ring buffer of historical roots.
/// @dev Based on Tornado Cash's MerkleTreeWithHistory, adapted for Poseidon.
contract IncrementalMerkleTree {
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint32 public immutable levels;
    uint32 public immutable ROOT_HISTORY_SIZE;

    mapping(uint256 => uint256) public filledSubtrees;
    mapping(uint256 => uint256) public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    constructor(uint32 _levels, uint32 _rootHistorySize) {
        require(_levels > 0 && _levels <= 20, "invalid levels");
        require(_rootHistorySize > 0, "invalid root history size");
        levels = _levels;
        ROOT_HISTORY_SIZE = _rootHistorySize;

        // Initialize with zero values
        // zeros[0] = 0
        // zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
        uint256 currentZero = 0;
        for (uint32 i = 0; i < _levels; i++) {
            filledSubtrees[i] = currentZero;
            currentZero = _hashPair(currentZero, currentZero);
        }
        roots[0] = currentZero;
    }

    function _hashPair(uint256 left, uint256 right) internal pure returns (uint256) {
        return PoseidonT3.hash([left, right]);
    }

    /// @notice Insert a leaf into the tree.
    /// @return index The index of the inserted leaf.
    function _insert(uint256 leaf) internal returns (uint32 index) {
        uint32 _nextIndex = nextIndex;
        require(_nextIndex < uint32(2) ** levels, "tree full");

        uint32 currentIndex = _nextIndex;
        uint256 currentHash = leaf;
        uint256 left;
        uint256 right;

        for (uint32 i = 0; i < levels; i++) {
            if (currentIndex % 2 == 0) {
                left = currentHash;
                right = _zeros(i);
                filledSubtrees[i] = currentHash;
            } else {
                left = filledSubtrees[i];
                right = currentHash;
            }
            currentHash = _hashPair(left, right);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentHash;
        nextIndex = _nextIndex + 1;

        return _nextIndex;
    }

    /// @notice Check if a root is known (within the ring buffer history).
    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 _currentRootIndex = currentRootIndex;
        uint32 i = _currentRootIndex;
        do {
            if (roots[i] == root) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != _currentRootIndex);
        return false;
    }

    /// @notice Get the current root.
    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }

    /// @dev Compute zero value at level i.
    ///      zeros[0] = 0, zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
    function _zeros(uint32 i) internal pure returns (uint256) {
        if (i == 0) return 0;
        // Pre-compute zeros for efficiency (up to depth 20)
        // These are constants derived from Poseidon(0,0), Poseidon(h,h), etc.
        if (i == 1) return 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864;
        if (i == 2) return 0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1;
        if (i == 3) return 0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238;
        if (i == 4) return 0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a;
        if (i == 5) return 0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55;
        if (i == 6) return 0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78;
        if (i == 7) return 0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d;
        if (i == 8) return 0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61;
        if (i == 9) return 0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747;
        if (i == 10) return 0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2;
        if (i == 11) return 0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636;
        if (i == 12) return 0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a;
        if (i == 13) return 0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0;
        if (i == 14) return 0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c;
        if (i == 15) return 0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92;
        if (i == 16) return 0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323;
        if (i == 17) return 0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992;
        if (i == 18) return 0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f;
        if (i == 19) return 0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca;
        revert("level too high");
    }
}
