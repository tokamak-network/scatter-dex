// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {SettleVerifyLib} from "../src/zk/SettleVerifyLib.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";

contract CTPToken is ERC20 {
    constructor() ERC20("USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @title ClaimToPoolTest
/// @notice Exercises `PrivateSettlement.claimToPool`: a stealth claim
///         that splits its output into N pool commitments atomically.
///         Setup runs `settleAuth` once to register a maker-side claims
///         group worth 20,000 USDC at root `CLAIMS_R`; tests then call
///         `claimToPool` against that group with various slice payloads.
contract ClaimToPoolTest is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    MockVerifier public withdrawVerifier;
    MockDepositVerifier public depositVerifier;
    MockClaimVerifier public claimVerifier;
    MockAuthorizeVerifier public authVerifier;
    MockWETH public weth;
    CTPToken public usdc;

    address makerRelayer = address(0xBEEF1);
    address takerRelayer = address(0xBEEF2);

    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant M_NULL       = bytes32(uint256(0xa1));
    bytes32 constant M_NONCE_NULL = bytes32(uint256(0xa2));
    bytes32 constant M_NEW_COMMIT = bytes32(uint256(0xa3));
    bytes32 constant CLAIMS_R     = bytes32(uint256(0xa4));
    bytes32 constant M_ORDER_HASH = bytes32(uint256(0xa5));
    bytes32 constant T_NULL       = bytes32(uint256(0xb1));
    bytes32 constant T_NONCE_NULL = bytes32(uint256(0xb2));
    bytes32 constant T_NEW_COMMIT = bytes32(uint256(0xb3));
    bytes32 constant T_CLAIMS_R   = bytes32(uint256(0xb4));
    bytes32 constant T_ORDER_HASH = bytes32(uint256(0xb5));

    bytes32 constant CLAIM_NULLIFIER = bytes32(uint256(0xCA11));
    uint256 constant CLAIM_AMOUNT = 20_000e18;

    function setUp() public {
        withdrawVerifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        weth = new MockWETH();
        settlement = new PrivateSettlement(
            address(pool),
            address(claimVerifier),
            address(weth)
        );
        usdc = new CTPToken();

        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);
        pool.setAuthorizedSettlement(address(settlement));
        settlement.setAuthorizeVerifier(16, address(authVerifier));

        // Fund the pool so settleAuth's transferToSettlement has tokens
        // to draw from. After settleAuth, the locked amounts move into
        // the settlement contract — that's where claimToPool reads from.
        vm.deal(address(this), 1100 ether);
        weth.deposit{value: 1100 ether}();
        weth.transfer(address(pool), 1000 ether);
        usdc.mint(address(pool), 1_000_000e18);

        // Register the maker-side claims group at CLAIMS_R worth
        // 20,000 USDC at tier 16 by running settleAuth.
        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        vm.prank(makerRelayer);
        settlement.settleAuth(p);

        // Sanity: settlement now holds the claim's buyToken liquidity.
        assertGe(usdc.balanceOf(address(settlement)), CLAIM_AMOUNT);
    }

    // ────────────────────────────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────────────────────────────

    function _defaultParams() internal view returns (PrivateSettlement.SettleAuthParams memory) {
        SettleVerifyLib.AuthorizeProof memory maker = SettleVerifyLib.AuthorizeProof({
            proofA: proofA, proofB: proofB, proofC: proofC,
            pubKeyBind: bytes32(uint256(0xC1)),
            commitmentRoot: pool.getLastRoot(),
            nullifier: M_NULL,
            nonceNullifier: M_NONCE_NULL,
            newCommitment: M_NEW_COMMIT,
            sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 10 ether, buyAmount: 20_000e18,
            maxFee: 100,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: CLAIMS_R,
            totalLocked: uint128(20_000e18),
            relayer: makerRelayer,
            orderHash: M_ORDER_HASH,
            tier: 16
        });
        SettleVerifyLib.AuthorizeProof memory taker = SettleVerifyLib.AuthorizeProof({
            proofA: proofA, proofB: proofB, proofC: proofC,
            pubKeyBind: bytes32(uint256(0xC2)),
            commitmentRoot: pool.getLastRoot(),
            nullifier: T_NULL,
            nonceNullifier: T_NONCE_NULL,
            newCommitment: T_NEW_COMMIT,
            sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 20_000e18, buyAmount: 10 ether,
            maxFee: 100,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: T_CLAIMS_R,
            totalLocked: uint128(10 ether),
            relayer: takerRelayer,
            orderHash: T_ORDER_HASH,
            tier: 16
        });
        return PrivateSettlement.SettleAuthParams({
            maker: maker, taker: taker, feeTokenMaker: 0, feeTokenTaker: 0
        });
    }

    function _slice(uint256 commitment, uint256 amount)
        internal pure returns (PrivateSettlement.ClaimToPoolSlice memory)
    {
        return PrivateSettlement.ClaimToPoolSlice({commitment: commitment, amount: amount});
    }

    function _equalSlices(uint256 n) internal pure returns (PrivateSettlement.ClaimToPoolSlice[] memory s) {
        s = new PrivateSettlement.ClaimToPoolSlice[](n);
        uint256 base = CLAIM_AMOUNT / n;
        uint256 rem = CLAIM_AMOUNT - base * n;
        for (uint256 i = 0; i < n; i++) {
            s[i] = _slice(uint256(keccak256(abi.encode("commit", i))), i == 0 ? base + rem : base);
        }
    }

    // ────────────────────────────────────────────────────────────
    //  Happy paths
    // ────────────────────────────────────────────────────────────

    function test_claimToPool_singleSlice() public {
        PrivateSettlement.ClaimToPoolSlice[] memory slices = new PrivateSettlement.ClaimToPoolSlice[](1);
        slices[0] = _slice(uint256(keccak256("commit-solo")), CLAIM_AMOUNT);

        uint256 settlementBefore = usdc.balanceOf(address(settlement));
        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.expectEmit(true, true, true, true);
        emit PrivateSettlement.PrivateClaimToPool(
            CLAIMS_R, CLAIM_NULLIFIER, address(usdc), CLAIM_AMOUNT, 1
        );
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            slices
        );

        // Tokens moved settlement → pool, exactly the claim amount
        assertEq(usdc.balanceOf(address(settlement)), settlementBefore - CLAIM_AMOUNT);
        assertEq(usdc.balanceOf(address(pool)), poolBefore + CLAIM_AMOUNT);
        // Nullifier marked
        assertTrue(settlement.claimNullifiers(CLAIM_NULLIFIER));
        // Group totalClaimed advanced
        (, uint128 totalClaimed,,) = settlement.claimsGroups(CLAIMS_R);
        assertEq(totalClaimed, CLAIM_AMOUNT);
    }

    function test_claimToPool_fourSlices_split() public {
        PrivateSettlement.ClaimToPoolSlice[] memory slices = _equalSlices(4);

        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            slices
        );

        // Sum of slices equals the claim
        uint256 sum;
        for (uint256 i = 0; i < slices.length; i++) sum += slices[i].amount;
        assertEq(sum, CLAIM_AMOUNT);
        // Tokens fully moved to pool
        assertEq(usdc.balanceOf(address(pool)), 1_000_000e18 + CLAIM_AMOUNT - 20_000e18); // settleAuth pulled 20k out for the maker side then claimToPool returns it
        // Pool received 4 commitments — its merkle tree advanced by 4
        // (no precise leafIndex assertion since other inserts could exist
        // but the next leaf index advances monotonically).
    }

    // ────────────────────────────────────────────────────────────
    //  Validation guards (reverts BEFORE nullifier mutation)
    // ────────────────────────────────────────────────────────────

    function test_claimToPool_emptySlices_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory empty = new PrivateSettlement.ClaimToPoolSlice[](0);

        vm.expectRevert(PrivateSettlement.EmptyBatch.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            empty
        );
        // Nullifier untouched — caller can retry with valid payload
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_tooManySlices_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](9);
        for (uint256 i = 0; i < 9; i++) {
            s[i] = _slice(uint256(keccak256(abi.encode("c", i))), CLAIM_AMOUNT / 9);
        }
        vm.expectRevert(PrivateSettlement.TooManySlices.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_sumMismatch_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](2);
        s[0] = _slice(1, CLAIM_AMOUNT / 2);
        s[1] = _slice(2, CLAIM_AMOUNT / 2 - 1); // off by one

        vm.expectRevert(PrivateSettlement.SumMismatch.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_zeroCommitment_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](1);
        s[0] = _slice(0, CLAIM_AMOUNT);

        vm.expectRevert(PrivateSettlement.InvalidSlice.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_zeroAmount_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](2);
        s[0] = _slice(1, CLAIM_AMOUNT);
        s[1] = _slice(2, 0); // zero amount

        vm.expectRevert(PrivateSettlement.InvalidSlice.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_tokenMismatch_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](1);
        s[0] = _slice(1, CLAIM_AMOUNT);

        vm.expectRevert(PrivateSettlement.TokenMismatch.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(weth), // wrong token
            uint64(block.timestamp),
            s
        );
    }

    function test_claimToPool_paused_reverts() public {
        settlement.setPaused(true);
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);

        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
    }

    function test_claimToPool_unknownClaimsRoot_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](1);
        s[0] = _slice(1, CLAIM_AMOUNT);

        vm.expectRevert(PrivateSettlement.ClaimsGroupNotFound.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            bytes32(uint256(0xDEADBEEF)), // unregistered root
            CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
    }

    function test_claimToPool_invalidProof_reverts() public {
        claimVerifier.setShouldPass(false);
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    // ────────────────────────────────────────────────────────────
    //  Cross-flow nullifier replay
    // ────────────────────────────────────────────────────────────

    function test_claimToPool_thenClaimWithProof_sameNullifier_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );

        // Same nullifier reused on the EOA path must revert — the
        // shared `claimNullifiers` mapping is the load-bearing
        // invariant for cross-flow safety.
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            address(0xDEAD),
            uint64(block.timestamp)
        );
    }

    function test_claimWithProof_thenClaimToPool_sameNullifier_reverts() public {
        // Reverse direction: EOA claim first, then claimToPool reuse.
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            address(0xCAFE),
            uint64(block.timestamp)
        );

        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
    }

    function test_claimToPool_replay_sameCall_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s
        );
        // Second call with the same nullifier reverts.
        PrivateSettlement.ClaimToPoolSlice[] memory s2 = _equalSlices(2);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimToPool(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER,
            CLAIM_AMOUNT, address(usdc),
            uint64(block.timestamp),
            s2
        );
    }
}
