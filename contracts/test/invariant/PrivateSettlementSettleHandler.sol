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
    mapping(bytes32 => bool) public seenClaimsRoot;
    mapping(bytes32 => uint128) public ghostTotalLocked;
    mapping(bytes32 => uint128) public ghostTotalClaimed;
    mapping(bytes32 => address) public ghostGroupToken;

    bytes32[] public observedEscrowNullifiers;
    bytes32[] public observedNonceNullifiers;
    bytes32[] public observedClaimNullifiers;

    uint256 internal escrowNullCtr = 1;
    uint256 internal nonceNullCtr  = 1_000_000;
    uint256 internal claimsRootCtr = 2_000_000;
    uint256 internal claimNullCtr  = 3_000_000;
    uint256 internal orderHashCtr  = 4_000_000;
    uint256 internal pubKeyCtr     = 5_000_000;

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

    function _nextEscrow() internal returns (bytes32) {
        bytes32 v = bytes32((escrowNullCtr++) & FIELD_SAFE_MASK);
        return v == bytes32(0) ? bytes32(uint256(1)) : v;
    }
    function _nextNonce() internal returns (bytes32) {
        bytes32 v = bytes32((nonceNullCtr++) & FIELD_SAFE_MASK);
        return v == bytes32(0) ? bytes32(uint256(1)) : v;
    }
    function _nextClaimsRoot() internal returns (bytes32) {
        bytes32 v = bytes32((claimsRootCtr++) & FIELD_SAFE_MASK);
        return v == bytes32(0) ? bytes32(uint256(1)) : v;
    }
    function _nextClaimNull() internal returns (bytes32) {
        bytes32 v = bytes32((claimNullCtr++) & FIELD_SAFE_MASK);
        return v == bytes32(0) ? bytes32(uint256(1)) : v;
    }
    function _nextOrderHash() internal returns (bytes32) {
        return bytes32((orderHashCtr++) & FIELD_SAFE_MASK);
    }
    function _nextPubKey() internal returns (bytes32) {
        return bytes32((pubKeyCtr++) & FIELD_SAFE_MASK);
    }

    // ─── actions ────────────────────────────────────────────────

    /// @notice Two-sided half-proof settle. tokenA<->tokenB at 1:1 rate
    ///         (price-match satisfied by construction). Both relayers
    ///         registered are pool-funded fresh per call.
    function settleAuth(uint256 relayerSeed, uint128 amtA, uint128 amtB) external {
        amtA = uint128(bound(amtA, 1, 1e22));
        amtB = uint128(bound(amtB, 1, 1e22));

        bytes32 makerClaimsRoot = _nextClaimsRoot();
        bytes32 takerClaimsRoot = _nextClaimsRoot();

        // makerSells tokenA, buys tokenB; taker mirror.
        SettleVerifyLib.AuthorizeProof memory maker = SettleVerifyLib.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: _nextPubKey(),
            commitmentRoot: pool.getLastRoot(),
            nullifier: _nextEscrow(),
            nonceNullifier: _nextNonce(),
            newCommitment: bytes32(0),
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: amtA,
            buyAmount: amtB,
            maxFee: 0,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: makerClaimsRoot,
            totalLocked: amtB,
            relayer: _relayer(relayerSeed),
            orderHash: _nextOrderHash(),
            tier: 16
        });
        SettleVerifyLib.AuthorizeProof memory taker = SettleVerifyLib.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: _nextPubKey(),
            commitmentRoot: pool.getLastRoot(),
            nullifier: _nextEscrow(),
            nonceNullifier: _nextNonce(),
            newCommitment: bytes32(0),
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: amtB,
            buyAmount: amtA,
            maxFee: 0,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: takerClaimsRoot,
            totalLocked: amtA,
            relayer: _relayer(relayerSeed + 1),
            orderHash: _nextOrderHash(),
            tier: 16
        });

        // Pre-fund pool so the two transferToSettlement calls succeed.
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
            seenClaimsRoot[makerClaimsRoot] = true;
            ghostTotalLocked[makerClaimsRoot] = amtB;
            ghostGroupToken[makerClaimsRoot] = address(tokenB);

            knownClaimsRoots.push(takerClaimsRoot);
            seenClaimsRoot[takerClaimsRoot] = true;
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
        bytes32 claimsRoot = _nextClaimsRoot();

        SettleVerifyLib.AuthorizeProof memory proof = SettleVerifyLib.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: _nextPubKey(),
            commitmentRoot: pool.getLastRoot(),
            nullifier: _nextEscrow(),
            nonceNullifier: _nextNonce(),
            newCommitment: bytes32(0),
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: sellAmount,
            buyAmount: sellAmount, // unused in dex validation
            maxFee: 0,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: claimsRoot,
            totalLocked: sellAmount, // 1:1 rate → amountOut == sellAmount
            relayer: relayer,
            orderHash: _nextOrderHash(),
            tier: 16
        });

        // Fund pool for the sell-side transfer and the DEX for the buy-side payout.
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
            seenClaimsRoot[claimsRoot] = true;
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
        bytes32 claimsRoot = _nextClaimsRoot();

        SettleVerifyLib.AuthorizeProof memory proof = SettleVerifyLib.AuthorizeProof({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            pubKeyBind: _nextPubKey(),
            commitmentRoot: pool.getLastRoot(),
            nullifier: _nextEscrow(),
            nonceNullifier: _nextNonce(),
            newCommitment: bytes32(0),
            sellToken: address(tokenA),
            buyToken: address(tokenA),
            sellAmount: amount,
            buyAmount: amount,
            maxFee: 0,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: claimsRoot,
            totalLocked: amount,
            relayer: relayer,
            orderHash: _nextOrderHash(),
            tier: 16
        });

        tokenA.mint(address(pool), amount);

        PrivateSettlement.ScatterDirectAuthParams memory p =
            PrivateSettlement.ScatterDirectAuthParams({proof: proof, fee: 0});

        vm.prank(relayer);
        try settlement.scatterDirectAuth(p) {
            knownClaimsRoots.push(claimsRoot);
            seenClaimsRoot[claimsRoot] = true;
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

        bytes32 nullifier = _nextClaimNull();
        if (_attemptClaim(root, nullifier, amount, ghostGroupToken[root], _recipient(recipientSeed))) {
            ghostTotalClaimed[root] += amount;
            observedClaimNullifiers.push(nullifier);
        }
    }

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
    function observedEscrowNullifiersCount() external view returns (uint256) { return observedEscrowNullifiers.length; }
    function observedNonceNullifiersCount() external view returns (uint256) { return observedNonceNullifiers.length; }
    function observedClaimNullifiersCount() external view returns (uint256) { return observedClaimNullifiers.length; }
}
