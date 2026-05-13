// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PrivateSettlement} from "../../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../../src/zk/CommitmentPool.sol";
import {SettleVerifyLib} from "../../src/zk/SettleVerifyLib.sol";
import {InvariantToken} from "./FeeVaultHandler.sol";

/// @dev Minimal swap router used by settleWithDex. Pulls sellToken from caller
///      and pushes buyToken at a fixed 1:1 rate. Funded by the handler before
///      each settleWithDex invocation.
contract InvariantDexRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn; // 1:1 rate keeps surplus = 0 → no FeeVault dependency
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}

/// @notice Actor-based handler covering the three deferred PrivateSettlement
///         entry points: `settleAuth` (two-sided half-proof), `settleWithDex`
///         (single-party DEX swap), and `scatterDirectAuth` (single-party
///         same-token authorize). Mocks accept every proof, so the harness
///         exercises the on-chain accounting layer — ClaimsGroup state, the
///         escrow / nonce nullifier maps, claim payout from settlement, and
///         the per-token escrow coverage relation.
contract PrivateSettlementSettleHandler is CommonBase, StdCheats, StdUtils {
    PrivateSettlement public immutable settlement;
    CommitmentPool public immutable pool;
    InvariantToken public immutable tokenA;
    InvariantToken public immutable tokenB;
    InvariantDexRouter public immutable dex;
    address public immutable owner;

    address[] internal relayers;
    address[] internal recipients;

    uint[2] internal proofA;
    uint[2][2] internal proofB;
    uint[2] internal proofC;

    uint256 internal constant FIELD_SAFE_MASK = (uint256(1) << 252) - 1;

    bytes32[] public knownClaimsRoots;
    mapping(bytes32 => uint128) public ghostTotalLocked;
    mapping(bytes32 => uint128) public ghostTotalClaimed;
    mapping(bytes32 => address) public ghostGroupToken;

    bytes32[] public observedEscrowNullifiers;
    bytes32[] public observedNonceNullifiers;
    bytes32[] public observedClaimNullifiers;

    /// @dev Single monotonic counter feeds every freshly-minted scalar
    ///      (nullifiers, nonce-nullifiers, claims roots, claim nullifiers,
    ///      order hashes, pubKey binds). Uniqueness across roles is all
    ///      that matters — the mocks ignore field semantics — so we don't
    ///      need per-role buckets.
    uint256 internal scalarCtr = 1;

    constructor(
        PrivateSettlement _settlement,
        CommitmentPool _pool,
        InvariantToken _tokenA,
        InvariantToken _tokenB,
        InvariantDexRouter _dex,
        address _owner
    ) {
        settlement = _settlement;
        pool = _pool;
        tokenA = _tokenA;
        tokenB = _tokenB;
        dex = _dex;
        owner = _owner;
        for (uint160 i = 1; i <= 3; ++i) relayers.push(address(uint160(0xA200 + i)));
        for (uint160 i = 1; i <= 4; ++i) recipients.push(address(uint160(0xB200 + i)));
    }

    // ─── utility ────────────────────────────────────────────────

    function _relayer(uint256 s) internal view returns (address) { return relayers[s % relayers.length]; }
    function _recipient(uint256 s) internal view returns (address) { return recipients[s % recipients.length]; }

    /// @dev Fresh non-zero BN254-safe scalar. Used for every nullifier /
    ///      claims root / order hash etc. — uniqueness is the only property.
    function _fresh() internal returns (bytes32) {
        bytes32 v = bytes32((scalarCtr++) & FIELD_SAFE_MASK);
        return v == bytes32(0) ? bytes32(uint256(1)) : v;
    }

    /// @dev Build an AuthorizeProof with the static fields filled in
    ///      (proof tuples, fresh nullifier/nonce/orderHash/pubKey, expiry,
    ///      maxFee=0, tier=16, empty change UTXO) and the caller-varying
    ///      fields stitched on top.
    function _buildProof(
        address sellToken,
        address buyToken,
        uint128 sellAmount,
        uint128 buyAmount,
        uint128 totalLocked,
        bytes32 claimsRoot,
        address relayer
    ) internal returns (SettleVerifyLib.AuthorizeProof memory) {
        return SettleVerifyLib.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: _fresh(),
            commitmentRoot: pool.getLastRoot(),
            nullifier: _fresh(),
            nonceNullifier: _fresh(),
            newCommitment: bytes32(0),
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            maxFee: 0,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: claimsRoot,
            totalLocked: totalLocked,
            relayer: relayer,
            orderHash: _fresh(),
            tier: 16
        });
    }

    // ─── actions ────────────────────────────────────────────────

    /// @notice Two-sided half-proof settle. tokenA<->tokenB at 1:1 rate
    ///         (price-match satisfied by construction). Pool is pre-funded
    ///         per call.
    function settleAuth(uint256 relayerSeed, uint128 amtA, uint128 amtB) external {
        amtA = uint128(bound(amtA, 1, 1e22));
        amtB = uint128(bound(amtB, 1, 1e22));

        bytes32 makerClaimsRoot = _fresh();
        bytes32 takerClaimsRoot = _fresh();

        SettleVerifyLib.AuthorizeProof memory maker = _buildProof(
            address(tokenA), address(tokenB), amtA, amtB, amtB, makerClaimsRoot, _relayer(relayerSeed)
        );
        SettleVerifyLib.AuthorizeProof memory taker = _buildProof(
            address(tokenB), address(tokenA), amtB, amtA, amtA, takerClaimsRoot, _relayer(relayerSeed + 1)
        );

        tokenB.mint(address(pool), amtB);
        tokenA.mint(address(pool), amtA);

        PrivateSettlement.SettleAuthParams memory p = PrivateSettlement.SettleAuthParams({
            maker: maker,
            taker: taker,
            feeTokenMaker: 0,
            feeTokenTaker: 0
        });

        vm.prank(maker.relayer);
        try settlement.settleAuth(p) {
            knownClaimsRoots.push(makerClaimsRoot);
            ghostTotalLocked[makerClaimsRoot] = amtB;
            ghostGroupToken[makerClaimsRoot] = address(tokenB);

            knownClaimsRoots.push(takerClaimsRoot);
            ghostTotalLocked[takerClaimsRoot] = amtA;
            ghostGroupToken[takerClaimsRoot] = address(tokenA);

            observedEscrowNullifiers.push(maker.nullifier);
            observedEscrowNullifiers.push(taker.nullifier);
            observedNonceNullifiers.push(maker.nonceNullifier);
            observedNonceNullifiers.push(taker.nonceNullifier);
        } catch {}
    }

    /// @notice Single-party DEX-settle via the InvariantDexRouter (1:1 rate).
    function settleWithDex(uint256 relayerSeed, uint128 sellAmount) external {
        sellAmount = uint128(bound(sellAmount, 1, 1e22));
        address relayer = _relayer(relayerSeed);
        bytes32 claimsRoot = _fresh();

        // 1:1 router rate → amountOut == sellAmount, so totalLocked == sellAmount.
        SettleVerifyLib.AuthorizeProof memory proof = _buildProof(
            address(tokenA), address(tokenB), sellAmount, sellAmount, sellAmount, claimsRoot, relayer
        );

        tokenA.mint(address(pool), sellAmount);
        tokenB.mint(address(dex), sellAmount);

        bytes memory dexCalldata = abi.encodeCall(
            InvariantDexRouter.swap,
            (address(tokenA), address(tokenB), sellAmount, address(settlement))
        );

        PrivateSettlement.SettleDexParams memory p = PrivateSettlement.SettleDexParams({
            proof: proof,
            dexRouter: address(dex),
            dexCalldata: dexCalldata,
            deadline: block.timestamp + 1 hours
        });

        vm.prank(relayer);
        try settlement.settleWithDex(p) {
            knownClaimsRoots.push(claimsRoot);
            ghostTotalLocked[claimsRoot] = sellAmount;
            ghostGroupToken[claimsRoot] = address(tokenB);

            observedEscrowNullifiers.push(proof.nullifier);
            observedNonceNullifiers.push(proof.nonceNullifier);
        } catch {}
    }

    /// @notice Single-party same-token scatter via authorize proof.
    function scatterDirectAuth(uint256 relayerSeed, uint128 amount) external {
        amount = uint128(bound(amount, 1, 1e22));
        address relayer = _relayer(relayerSeed);
        bytes32 claimsRoot = _fresh();

        SettleVerifyLib.AuthorizeProof memory proof = _buildProof(
            address(tokenA), address(tokenA), amount, amount, amount, claimsRoot, relayer
        );

        tokenA.mint(address(pool), amount);

        PrivateSettlement.ScatterDirectAuthParams memory p =
            PrivateSettlement.ScatterDirectAuthParams({proof: proof, fee: 0});

        vm.prank(relayer);
        try settlement.scatterDirectAuth(p) {
            knownClaimsRoots.push(claimsRoot);
            ghostTotalLocked[claimsRoot] = amount;
            ghostGroupToken[claimsRoot] = address(tokenA);

            observedEscrowNullifiers.push(proof.nullifier);
            observedNonceNullifiers.push(proof.nonceNullifier);
        } catch {}
    }

    /// @notice Claim a slice of a known claims group via mock claim verifier.
    function claim(uint256 rootSeed, uint256 recipientSeed, uint128 amount) external {
        uint256 n = knownClaimsRoots.length;
        if (n == 0) return;
        bytes32 root = knownClaimsRoots[rootSeed % n];

        uint128 remaining = ghostTotalLocked[root] - ghostTotalClaimed[root];
        if (remaining == 0) return;
        amount = uint128(bound(amount, 1, remaining));

        bytes32 nullifier = _fresh();
        if (_attemptClaim(root, nullifier, amount, ghostGroupToken[root], _recipient(recipientSeed))) {
            ghostTotalClaimed[root] += amount;
            observedClaimNullifiers.push(nullifier);
        }
    }

    /// @dev Extracted from `claim` to keep the parent under solc's stack-depth limit.
    function _attemptClaim(
        bytes32 root,
        bytes32 nullifier,
        uint128 amount,
        address token,
        address recipient
    ) internal returns (bool) {
        try settlement.claimWithProof(
            proofA, proofB, proofC,
            root, nullifier,
            uint256(amount),
            token,
            recipient,
            0
        ) {
            return true;
        } catch {
            return false;
        }
    }

    function flipPause(bool paused) external {
        vm.prank(owner);
        if (paused) try settlement.pause() {} catch {}
        else try settlement.unpause() {} catch {}
    }

    // ─── views ──────────────────────────────────────────────────

    function knownClaimsRootsCount() external view returns (uint256) { return knownClaimsRoots.length; }
    function allKnownClaimsRoots() external view returns (bytes32[] memory) { return knownClaimsRoots; }
    function allObservedEscrowNullifiers() external view returns (bytes32[] memory) { return observedEscrowNullifiers; }
    function allObservedNonceNullifiers() external view returns (bytes32[] memory) { return observedNonceNullifiers; }
    function allObservedClaimNullifiers() external view returns (bytes32[] memory) { return observedClaimNullifiers; }
}
