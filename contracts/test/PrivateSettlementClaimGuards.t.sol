// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract PscToken is ERC20 {
    constructor() ERC20("Psc", "PSC") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @title PrivateSettlementClaimGuardsTest
/// @notice Drives scatterDirect to register a real claimsGroup, then
///         exhaustively tests every revert branch inside _executeClaim
///         + the scatterDirect early-revert guards. Complements the
///         Admin / Guards suites in the Track B trail.
contract PrivateSettlementClaimGuardsTest is Test {
    PrivateSettlement settlement;
    CommitmentPool pool;
    MockWETH weth;
    PscToken token;
    MockClaimVerifier claimVerifier;

    address alice = address(0xA11CE);
    address relayer = address(0xBEEF);

    // claimsRoot used by the test fixture (scatterDirect registers under this).
    bytes32 constant TEST_CLAIMS_ROOT = bytes32(uint256(0xC1A1));
    bytes32 constant WETH_CLAIMS_ROOT = bytes32(uint256(0xC1A2));

    // Below the BN254 scalar field max so deposit's range check passes.
    uint256 constant COMMITMENT = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;

    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        weth = new MockWETH();
        token = new PscToken();

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier), address(weth)
        );

        pool.setTokenWhitelist(address(token), true);
        pool.setTokenWhitelist(address(weth), true);
        pool.setAuthorizedSettlement(address(settlement));

        settlement.setTokenWhitelist(address(token), true);
        settlement.setTokenWhitelist(address(weth), true);
        // setUp seeds tier-16 claim verifier; explicitly wire it just to be
        // resilient to ProxyDeployer wiring changes.
        settlement.setClaimVerifier(16, address(claimVerifier));

        // Fund pool with both tokens so withdrawFor + WETH-unwrap paths work.
        token.mint(address(pool), 1_000 ether);
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 10 ether}();
        weth.transfer(address(pool), 10 ether);

        // Seed at least one commitment so pool.getLastRoot() reflects a
        // known root. MockDepositVerifier short-circuits the ZK check, but
        // CommitmentPool.deposit still pulls tokens via safeTransferFrom
        // and verifies the balance delta — fund + approve alice first.
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(pool), 100 ether);
        pool.deposit(proofA, proofB, proofC, COMMITMENT, address(token), 1 ether);
        vm.stopPrank();
    }

    function _registerErc20Group() internal {
        // scatterDirect: relayer pays no fee, withdrawAmount == totalLocked.
        PrivateSettlement.ScatterDirectParams memory p = PrivateSettlement.ScatterDirectParams({
            proofA: proofA, proofB: proofB, proofC: proofC,
            currentRoot: pool.getLastRoot(),
            nullifier: bytes32(uint256(0xABCD)),
            newCommitment: 0,
            token: address(token),
            withdrawAmount: 10 ether,
            claimsRoot: TEST_CLAIMS_ROOT,
            totalLocked: 10 ether,
            fee: 0
        });
        vm.prank(relayer);
        settlement.scatterDirect(p);
    }

    function _registerWethGroup() internal {
        PrivateSettlement.ScatterDirectParams memory p = PrivateSettlement.ScatterDirectParams({
            proofA: proofA, proofB: proofB, proofC: proofC,
            currentRoot: pool.getLastRoot(),
            nullifier: bytes32(uint256(0xDCBA)),
            newCommitment: 0,
            token: address(weth),
            withdrawAmount: 5 ether,
            claimsRoot: WETH_CLAIMS_ROOT,
            totalLocked: 5 ether,
            fee: 0
        });
        vm.prank(relayer);
        settlement.scatterDirect(p);
    }

    // ─── scatterDirect early-revert guards ──────────────────────

    function test_scatterDirect_unwhitelistedToken_reverts() public {
        PscToken stranger = new PscToken();
        PrivateSettlement.ScatterDirectParams memory p = PrivateSettlement.ScatterDirectParams({
            proofA: proofA, proofB: proofB, proofC: proofC,
            currentRoot: pool.getLastRoot(),
            nullifier: bytes32(uint256(0x11)),
            newCommitment: 0,
            token: address(stranger),
            withdrawAmount: 1 ether,
            claimsRoot: bytes32(uint256(0xAA)),
            totalLocked: 1 ether,
            fee: 0
        });
        vm.prank(relayer);
        vm.expectRevert(PrivateSettlement.TokenNotWhitelisted.selector);
        settlement.scatterDirect(p);
    }

    function test_scatterDirect_amountOverflow_reverts() public {
        // withdrawAmount must equal totalLocked + fee.
        PrivateSettlement.ScatterDirectParams memory p = PrivateSettlement.ScatterDirectParams({
            proofA: proofA, proofB: proofB, proofC: proofC,
            currentRoot: pool.getLastRoot(),
            nullifier: bytes32(uint256(0x12)),
            newCommitment: 0,
            token: address(token),
            withdrawAmount: 2 ether,
            claimsRoot: bytes32(uint256(0xAB)),
            totalLocked: 1 ether,
            fee: 0
        });
        vm.prank(relayer);
        vm.expectRevert(PrivateSettlement.AmountOverflow.selector);
        settlement.scatterDirect(p);
    }

    function test_scatterDirect_unknownRoot_reverts() public {
        PrivateSettlement.ScatterDirectParams memory p = PrivateSettlement.ScatterDirectParams({
            proofA: proofA, proofB: proofB, proofC: proofC,
            currentRoot: uint256(0xDEAD),
            nullifier: bytes32(uint256(0x13)),
            newCommitment: 0,
            token: address(token),
            withdrawAmount: 1 ether,
            claimsRoot: bytes32(uint256(0xAC)),
            totalLocked: 1 ether,
            fee: 0
        });
        vm.prank(relayer);
        vm.expectRevert(PrivateSettlement.UnknownRoot.selector);
        settlement.scatterDirect(p);
    }

    function test_scatterDirect_nullifierReplay_reverts() public {
        _registerErc20Group(); // uses nullifier 0xABCD
        PrivateSettlement.ScatterDirectParams memory p = PrivateSettlement.ScatterDirectParams({
            proofA: proofA, proofB: proofB, proofC: proofC,
            currentRoot: pool.getLastRoot(),
            nullifier: bytes32(uint256(0xABCD)),
            newCommitment: 0,
            token: address(token),
            withdrawAmount: 1 ether,
            claimsRoot: bytes32(uint256(0xAD)),
            totalLocked: 1 ether,
            fee: 0
        });
        vm.prank(relayer);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.scatterDirect(p);
    }

    function test_scatterDirect_happyPath_registers_claimsGroup() public {
        _registerErc20Group();
        assertTrue(settlement.nullifiers(bytes32(uint256(0xABCD))));
        // Direct claimsGroups probe — confirms token/totalLocked/tier landed.
        (uint128 totalLocked, uint128 totalClaimed, address gToken, uint8 tier) =
            settlement.claimsGroups(TEST_CLAIMS_ROOT);
        assertEq(gToken, address(token));
        assertEq(totalLocked, 10 ether);
        assertEq(totalClaimed, 0);
        assertEq(tier, 16);
    }

    // ─── _executeClaim revert guards (via claimWithProof) ───────

    function test_executeClaim_groupNotFound_reverts() public {
        // No scatter yet — claimsGroup not registered.
        vm.expectRevert(PrivateSettlement.ClaimsGroupNotFound.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            bytes32(uint256(0xBAD0)),
            bytes32(uint256(0x01)),
            1 ether, address(token), alice, block.timestamp
        );
    }

    function test_executeClaim_amountOverflow_reverts() public {
        _registerErc20Group();
        vm.expectRevert(PrivateSettlement.AmountOverflow.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x02)),
            uint256(type(uint128).max) + 1,
            address(token), alice, block.timestamp
        );
    }

    function test_executeClaim_exceedsTotalLocked_reverts() public {
        _registerErc20Group(); // group totalLocked = 10 ether
        vm.expectRevert(PrivateSettlement.ExceedsTotalLocked.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x03)),
            11 ether, address(token), alice, block.timestamp
        );
    }

    function test_executeClaim_notYetReleasable_reverts() public {
        _registerErc20Group();
        vm.expectRevert(PrivateSettlement.NotYetReleasable.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x04)),
            1 ether, address(token), alice, block.timestamp + 1 days
        );
    }

    function test_executeClaim_tokenMismatch_reverts() public {
        _registerErc20Group(); // group.token = address(token)
        vm.expectRevert(PrivateSettlement.TokenMismatch.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x05)),
            1 ether, address(weth), alice, block.timestamp
        );
    }

    function test_executeClaim_tierNotConfigured_reverts() public {
        _registerErc20Group();
        settlement.setClaimVerifier(16, address(0)); // disable tier 16
        vm.expectRevert(abi.encodeWithSelector(PrivateSettlement.TierNotConfigured.selector, uint8(16)));
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x06)),
            1 ether, address(token), alice, block.timestamp
        );
    }

    function test_executeClaim_invalidProof_reverts() public {
        _registerErc20Group();
        claimVerifier.setShouldPass(false);
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x07)),
            1 ether, address(token), alice, block.timestamp
        );
    }

    function test_executeClaim_nullifierReplay_reverts() public {
        _registerErc20Group();
        bytes32 nul = bytes32(uint256(0x08));
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT, nul,
            1 ether, address(token), alice, block.timestamp
        );
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT, nul,
            1 ether, address(token), alice, block.timestamp
        );
    }

    function test_executeClaim_erc20_happyPath_transfersTokens() public {
        _registerErc20Group();
        uint256 before_ = token.balanceOf(alice);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT, bytes32(uint256(0x09)),
            3 ether, address(token), alice, block.timestamp
        );
        assertEq(token.balanceOf(alice), before_ + 3 ether);
    }

    function test_executeClaim_weth_unwraps_to_eth() public {
        _registerWethGroup();
        uint256 before_ = alice.balance;
        settlement.claimWithProof(
            proofA, proofB, proofC,
            WETH_CLAIMS_ROOT, bytes32(uint256(0x0A)),
            2 ether, address(weth), alice, block.timestamp
        );
        assertEq(alice.balance, before_ + 2 ether);
    }
}
