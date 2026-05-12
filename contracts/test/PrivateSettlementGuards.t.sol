// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockCancelVerifier} from "./mocks/MockCancelVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract PsgToken is ERC20 {
    constructor() ERC20("Psg", "PSG") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @title PrivateSettlementGuardsTest
/// @notice Targets the revert-guard branches inside cancelPrivate /
///         claimWithProofBatch / receive() / _executeClaim that the
///         integration suites don't reach. Companion to
///         PrivateSettlementAdminTest (admin/setter coverage).
contract PrivateSettlementGuardsTest is Test {
    PrivateSettlement settlement;
    CommitmentPool pool;
    MockWETH weth;
    PsgToken token;
    MockClaimVerifier claimVerifier;
    MockCancelVerifier cancelVerifier;

    address alice = address(0xA11CE);

    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        cancelVerifier = new MockCancelVerifier();
        weth = new MockWETH();
        token = new PsgToken();

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
    }

    // ─── cancelPrivate guards ───────────────────────────────────

    function test_cancelPrivate_noVerifier_reverts() public {
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(uint256(1)));
        vm.expectRevert(PrivateSettlement.CancelVerifierNotSet.selector);
        settlement.cancelPrivate(p);
    }

    function test_cancelPrivate_zeroNewCommitment_reverts() public {
        settlement.setCancelVerifier(address(cancelVerifier));
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(0));
        vm.expectRevert(PrivateSettlement.ZeroAddress.selector);
        settlement.cancelPrivate(p);
    }

    function test_cancelPrivate_nullifierReplay_reverts() public {
        settlement.setCancelVerifier(address(cancelVerifier));
        bytes32 oldNull = bytes32(uint256(0xAA));
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(uint256(1)));
        p.oldNullifier = oldNull;
        p.commitmentRoot = pool.getLastRoot();
        settlement.cancelPrivate(p);
        // second attempt with same oldNullifier
        p.oldNullifier = oldNull;
        p.newCommitment = bytes32(uint256(2));
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.cancelPrivate(p);
    }

    function test_cancelPrivate_sameEscrowAndNonceNullifier_reverts() public {
        settlement.setCancelVerifier(address(cancelVerifier));
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(uint256(1)));
        p.oldNullifier = bytes32(uint256(0xFF));
        p.oldNonceNullifier = bytes32(uint256(0xFF));
        p.commitmentRoot = pool.getLastRoot();
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.cancelPrivate(p);
    }

    function test_cancelPrivate_unknownRoot_reverts() public {
        settlement.setCancelVerifier(address(cancelVerifier));
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(uint256(1)));
        p.commitmentRoot = uint256(0xDEAD);
        vm.expectRevert(PrivateSettlement.UnknownRoot.selector);
        settlement.cancelPrivate(p);
    }

    function test_cancelPrivate_invalidProof_reverts() public {
        settlement.setCancelVerifier(address(cancelVerifier));
        cancelVerifier.setShouldPass(false);
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(uint256(1)));
        p.commitmentRoot = pool.getLastRoot();
        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.cancelPrivate(p);
    }

    function test_cancelPrivate_happyPath() public {
        settlement.setCancelVerifier(address(cancelVerifier));
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(uint256(0xC0DE)));
        p.commitmentRoot = pool.getLastRoot();
        settlement.cancelPrivate(p);
        assertTrue(settlement.nullifiers(p.oldNullifier));
        assertTrue(settlement.nonceNullifiers(p.oldNonceNullifier));
    }

    function test_cancelPrivate_paused_reverts() public {
        settlement.setCancelVerifier(address(cancelVerifier));
        settlement.pause();
        PrivateSettlement.CancelParams memory p = _cancelParams(bytes32(uint256(1)));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        settlement.cancelPrivate(p);
    }

    // ─── claimWithProofBatch guards ─────────────────────────────

    function test_claimWithProofBatch_empty_reverts() public {
        PrivateSettlement.ClaimParams[] memory claims = new PrivateSettlement.ClaimParams[](0);
        vm.expectRevert(PrivateSettlement.EmptyBatch.selector);
        settlement.claimWithProofBatch(claims);
    }

    function test_claimWithProofBatch_tooLarge_reverts() public {
        uint256 max = settlement.MAX_CLAIM_BATCH_SIZE();
        PrivateSettlement.ClaimParams[] memory claims = new PrivateSettlement.ClaimParams[](max + 1);
        vm.expectRevert(PrivateSettlement.BatchTooLarge.selector);
        settlement.claimWithProofBatch(claims);
    }

    function test_claimWithProofBatch_paused_reverts() public {
        settlement.pause();
        PrivateSettlement.ClaimParams[] memory claims = new PrivateSettlement.ClaimParams[](1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        settlement.claimWithProofBatch(claims);
    }

    // ─── _executeClaim guards (via claimWithProof) ──────────────

    function test_claimWithProof_zeroRecipient_reverts() public {
        vm.expectRevert(PrivateSettlement.ZeroAddress.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            bytes32(uint256(1)), bytes32(uint256(2)),
            1 ether, address(token), address(0), block.timestamp
        );
    }

    // ─── receive() guards ───────────────────────────────────────

    function test_receive_nonWeth_reverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(PrivateSettlement.OnlyWETH.selector);
        (bool ok, ) = address(settlement).call{value: 1 ether}("");
        ok; // silence unused-warning — the expectRevert above is the assertion
    }

    function test_receive_fromWeth_succeeds() public {
        vm.deal(address(weth), 1 ether);
        vm.prank(address(weth));
        (bool ok, ) = address(settlement).call{value: 1 ether}("");
        assertTrue(ok, "settlement accepts ETH from WETH callback");
    }

    // ─── helpers ────────────────────────────────────────────────

    function _cancelParams(bytes32 newCommitment)
        internal
        view
        returns (PrivateSettlement.CancelParams memory)
    {
        return PrivateSettlement.CancelParams({
            proofA: proofA,
            proofB: proofB,
            proofC: proofC,
            commitmentRoot: pool.getLastRoot(),
            oldNullifier: bytes32(uint256(0xCAFE)),
            oldNonceNullifier: bytes32(uint256(0xBEEF)),
            newCommitment: newCommitment
        });
    }
}
