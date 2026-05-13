// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";

/// @notice Actor-based handler for PrivateSettlement.scatterDirect + claimWithProof.
/// @dev    Mocks accept any proof, so the harness exercises the on-chain accounting
///         layer: `ClaimsGroup.totalLocked / totalClaimed`, the claim nullifier
///         mapping, and the pool → settlement → recipient token flow.
contract ScatterClaimHandler is CommonBase, StdCheats, StdUtils {
    PrivateSettlement public immutable settlement;
    CommitmentPool public immutable pool;
    InvariantToken public immutable token;
    address public immutable owner;

    address[] public relayers;
    address[] public recipients;

    uint[2] internal proofA;
    uint[2][2] internal proofB;
    uint[2] internal proofC;

    /// @dev Stay below BN254 field modulus for nullifiers/roots that get fed to mock proofs.
    uint256 internal constant FIELD_SAFE_MASK = (uint256(1) << 252) - 1;

    bytes32[] public knownClaimsRoots;
    mapping(bytes32 => bool) public seenClaimsRoot;
    mapping(bytes32 => uint128) public ghostTotalLocked;
    mapping(bytes32 => uint128) public ghostTotalClaimed;

    mapping(bytes32 => bool) public ghostClaimNullifierSeenTrue;
    bytes32[] public observedClaimNullifiers;

    uint256 public ghostScatterNullifierCounter = 1;
    uint256 public ghostClaimsRootCounter = 1;
    uint256 public ghostClaimNullifierCounter = 1;

    uint256 public ghostTotalLockedAtSettlement;
    uint256 public ghostTotalClaimedOut;

    constructor(
        PrivateSettlement _settlement,
        CommitmentPool _pool,
        InvariantToken _token,
        address _owner
    ) {
        settlement = _settlement;
        pool = _pool;
        token = _token;
        owner = _owner;

        for (uint160 i = 1; i <= 3; ++i) relayers.push(address(uint160(0xA100 + i)));
        for (uint160 i = 1; i <= 5; ++i) recipients.push(address(uint160(0xB100 + i)));
    }

    function _relayer(uint256 s) internal view returns (address) { return relayers[s % relayers.length]; }
    function _recipient(uint256 s) internal view returns (address) { return recipients[s % recipients.length]; }

    /// @notice Single-party scatter. Pre-funds the pool then registers a fresh
    ///         ClaimsGroup whose totalLocked is what's now sitting at the settlement.
    function scatter(uint256 relayerSeed, uint128 totalLocked, uint96 fee) external {
        totalLocked = uint128(bound(totalLocked, 1, 1e22));
        fee = uint96(bound(fee, 0, 1e20));
        uint256 withdrawAmount = uint256(totalLocked) + uint256(fee);

        // Pre-fund the pool so `withdrawFor` actually has tokens to move.
        token.mint(address(pool), withdrawAmount);

        bytes32 nullifier = bytes32((ghostScatterNullifierCounter++) & FIELD_SAFE_MASK);
        if (nullifier == bytes32(0)) nullifier = bytes32(uint256(1));
        bytes32 claimsRoot = bytes32((ghostClaimsRootCounter++) & FIELD_SAFE_MASK);
        if (claimsRoot == bytes32(0)) claimsRoot = bytes32(uint256(1));

        address relayer = _relayer(relayerSeed);
        PrivateSettlement.ScatterDirectParams memory p = PrivateSettlement.ScatterDirectParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            currentRoot: pool.getLastRoot(),
            nullifier: nullifier,
            newCommitment: bytes32(0),     // empty change UTXO
            token: address(token),
            withdrawAmount: withdrawAmount,
            claimsRoot: claimsRoot,
            totalLocked: totalLocked,
            fee: fee
        });

        vm.prank(relayer);
        try settlement.scatterDirect(p) {
            knownClaimsRoots.push(claimsRoot);
            seenClaimsRoot[claimsRoot] = true;
            ghostTotalLocked[claimsRoot] = totalLocked;
            ghostTotalLockedAtSettlement += totalLocked;
        } catch {}
    }

    /// @notice Claim against a previously-registered group.
    function claim(uint256 rootSeed, uint256 recipientSeed, uint128 amount) external {
        uint256 n = knownClaimsRoots.length;
        if (n == 0) return;
        bytes32 root = knownClaimsRoots[rootSeed % n];

        uint128 remaining = ghostTotalLocked[root] - ghostTotalClaimed[root];
        if (remaining == 0) return;
        amount = uint128(bound(amount, 1, remaining));

        bytes32 nullifier = bytes32((ghostClaimNullifierCounter++) & FIELD_SAFE_MASK);
        if (nullifier == bytes32(0)) nullifier = bytes32(uint256(1));

        try settlement.claimWithProof(
            proofA, proofB, proofC,
            root, nullifier,
            uint256(amount),
            address(token),
            _recipient(recipientSeed),
            0 // releaseTime = 0 always claimable
        ) {
            ghostTotalClaimed[root] += amount;
            ghostTotalClaimedOut += amount;
            ghostClaimNullifierSeenTrue[nullifier] = true;
            observedClaimNullifiers.push(nullifier);
        } catch {}
    }

    function flipPause(bool paused) external {
        vm.prank(owner);
        if (paused) try settlement.pause() {} catch {}
        else try settlement.unpause() {} catch {}
    }

    function knownClaimsRootsCount() external view returns (uint256) { return knownClaimsRoots.length; }
    function observedClaimNullifiersCount() external view returns (uint256) { return observedClaimNullifiers.length; }
}
