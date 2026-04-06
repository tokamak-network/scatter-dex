// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockSettleVerifier} from "./mocks/MockSettleVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";

contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract PrivateSettlementTest is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    MockVerifier public withdrawVerifier;
    MockSettleVerifier public settleVerifier;
    MockClaimVerifier public claimVerifier;
    MockToken public weth;
    MockToken public usdc;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address recipient1 = address(0xC1);
    address recipient2 = address(0xC2);

    // Dummy values for ZK proof params (mock verifier accepts anything)
    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant MAKER_NULL = bytes32(uint256(0xaa));
    bytes32 constant TAKER_NULL = bytes32(uint256(0xbb));
    bytes32 constant MAKER_NONCE_NULL = bytes32(uint256(0xcc));
    bytes32 constant TAKER_NONCE_NULL = bytes32(uint256(0xdd));
    bytes32 constant MAKER_NEW_COMMIT = bytes32(uint256(0x111));
    bytes32 constant TAKER_NEW_COMMIT = bytes32(uint256(0x222));
    bytes32 constant CLAIMS_ROOT_MAKER = bytes32(uint256(0x333));
    bytes32 constant CLAIMS_ROOT_TAKER = bytes32(uint256(0x444));
    bytes32 constant CLAIM_NULL_1 = bytes32(uint256(0x555));
    bytes32 constant CLAIM_NULL_2 = bytes32(uint256(0x666));

    function setUp() public {
        withdrawVerifier = new MockVerifier();
        settleVerifier = new MockSettleVerifier();
        claimVerifier = new MockClaimVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), 20, 30);
        settlement = new PrivateSettlement(address(pool), address(settleVerifier), address(claimVerifier));

        weth = new MockToken("WETH", "WETH");
        usdc = new MockToken("USDC", "USDC");

        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);

        // Authorize settlement contract to insert commitments into the pool
        pool.setAuthorizedSettlement(address(settlement));

        // Fund pool with tokens (simulates tokens locked via deposits)
        // In real flow: users deposit via CommitmentPool.deposit()
        // For testing: directly mint to settlement contract
        weth.mint(address(settlement), 1000 ether);
        usdc.mint(address(settlement), 100_000e18);

        // Also deposit some into pool for commitment tree root
        weth.mint(alice, 100 ether);
        vm.prank(alice);
        weth.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        pool.deposit(uint256(0x1234), address(weth), 10 ether);
    }

    // ─── settlePrivate Tests ─────────────────────────────────────

    function test_settlePrivate_basic() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Nullifiers should be marked
        assertTrue(settlement.nullifiers(MAKER_NULL));
        assertTrue(settlement.nullifiers(TAKER_NULL));
        assertTrue(settlement.nonceNullifiers(MAKER_NONCE_NULL));
        assertTrue(settlement.nonceNullifiers(TAKER_NONCE_NULL));

        // Claims groups should be registered
        (address token1, uint96 locked1, uint96 claimed1) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(token1, address(weth));
        assertEq(locked1, 5 ether);
        assertEq(claimed1, 0);

        (address token2, uint96 locked2,) = settlement.claimsGroups(CLAIMS_ROOT_TAKER);
        assertEq(token2, address(usdc));
        assertEq(locked2, 10_000e18);
    }

    function test_settlePrivate_emits_event() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();

        vm.expectEmit(true, true, false, true);
        emit PrivateSettlement.PrivateSettled(MAKER_NULL, TAKER_NULL, CLAIMS_ROOT_MAKER, CLAIMS_ROOT_TAKER, address(this), 0, 0);

        settlement.settlePrivate(p);
    }

    function test_settlePrivate_double_nullifier_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_invalid_proof_reverts() public {
        settleVerifier.setShouldPass(false);
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_paused_reverts() public {
        settlement.setPaused(true);
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();

        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.settlePrivate(p);
    }

    function test_settlePrivate_unwhitelisted_token_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        p.tokenMaker = address(0xDEAD);

        vm.expectRevert(PrivateSettlement.TokenNotWhitelisted.selector);
        settlement.settlePrivate(p);
    }

    // ─── claimWithProof Tests ────────────────────────────────────

    function test_claimWithProof_basic() public {
        // First settle to create a claims group
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        uint256 claimAmount = 2 ether;
        uint256 releaseTime = block.timestamp; // immediately claimable

        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER,
            CLAIM_NULL_1,
            claimAmount,
            address(weth),
            recipient1,
            releaseTime
        );

        // Recipient received tokens
        assertEq(weth.balanceOf(recipient1), claimAmount);
        assertTrue(settlement.claimNullifiers(CLAIM_NULL_1));

        // Claims group updated
        (,, uint96 claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, claimAmount);
    }

    function test_claimWithProof_multiple_claims() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        // Claim 1
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            2 ether, address(weth), recipient1, block.timestamp
        );

        // Claim 2
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_2,
            3 ether, address(weth), recipient2, block.timestamp
        );

        assertEq(weth.balanceOf(recipient1), 2 ether);
        assertEq(weth.balanceOf(recipient2), 3 ether);

        (,, uint96 claimed) = settlement.claimsGroups(CLAIMS_ROOT_MAKER);
        assertEq(claimed, 5 ether); // all claimed
    }

    function test_claimWithProof_exceeds_locked_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        vm.expectRevert(PrivateSettlement.ExceedsTotalLocked.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            6 ether, // exceeds 5 ether locked
            address(weth), recipient1, block.timestamp
        );
    }

    function test_claimWithProof_double_claim_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1, block.timestamp
        );

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1, block.timestamp
        );
    }

    function test_claimWithProof_not_yet_releasable_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        vm.expectRevert(PrivateSettlement.NotYetReleasable.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1,
            block.timestamp + 1 hours // future release time
        );
    }

    function test_claimWithProof_invalid_proof_reverts() public {
        PrivateSettlement.SettleParams memory p = _defaultSettleParams();
        settlement.settlePrivate(p);

        claimVerifier.setShouldPass(false);

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_ROOT_MAKER, CLAIM_NULL_1,
            1 ether, address(weth), recipient1, block.timestamp
        );
    }

    // ─── Refund Tests ────────────────────────────────────────────

    // ─── Helpers ─────────────────────────────────────────────────

    function _defaultSettleParams() internal view returns (PrivateSettlement.SettleParams memory) {
        return PrivateSettlement.SettleParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            currentRoot: pool.getLastRoot(),
            currentTimestamp: block.timestamp,
            makerNullifier: MAKER_NULL,
            takerNullifier: TAKER_NULL,
            makerNonceNullifier: MAKER_NONCE_NULL,
            takerNonceNullifier: TAKER_NONCE_NULL,
            makerNewCommitment: MAKER_NEW_COMMIT,
            takerNewCommitment: TAKER_NEW_COMMIT,
            claimsRootMaker: CLAIMS_ROOT_MAKER,
            claimsRootTaker: CLAIMS_ROOT_TAKER,
            totalLockedMaker: uint96(5 ether),
            totalLockedTaker: uint96(10_000e18),
            tokenMaker: address(weth),
            tokenTaker: address(usdc),
            feeTokenMaker: 0,
            feeTokenTaker: 0
        });
    }
}
