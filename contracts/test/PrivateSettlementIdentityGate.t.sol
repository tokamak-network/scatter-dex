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
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract PsigToken is ERC20 {
    constructor() ERC20("Psig", "PSIG") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @dev Covers the on-chain zk-X509 identity gate on PrivateSettlement:
///      `_executeClaim` (reached via `claimWithProof`) gates the claim
///      recipient, and the check is opt-in (no gate set → unchanged).
contract PrivateSettlementIdentityGateTest is Test {
    PrivateSettlement settlement;
    CommitmentPool pool;
    MockWETH weth;
    PsigToken token;
    MockClaimVerifier claimVerifier;
    MockIdentityRegistry gate;

    address alice = address(0xA11CE); // depositor
    address bob = address(0xB0B);     // claim recipient
    address relayer = address(0xBEEF);

    bytes32 constant TEST_CLAIMS_ROOT = bytes32(uint256(0xC1A1));
    uint256 constant COMMITMENT = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;

    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        weth = new MockWETH();
        token = new PsigToken();
        gate = new MockIdentityRegistry();

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier), address(weth)
        );

        pool.setTokenWhitelist(address(token), true);
        pool.setAuthorizedSettlement(address(settlement));
        settlement.setTokenWhitelist(address(token), true);
        settlement.setClaimVerifier(16, address(claimVerifier));

        token.mint(address(pool), 1_000 ether);

        // Seed a commitment so pool.getLastRoot() is non-trivial. alice is
        // verified here so this deposit isn't itself blocked once the pool
        // gate is set in the gated tests.
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(pool), 100 ether);
        pool.deposit(proofA, proofB, proofC, COMMITMENT, address(token), 1 ether);
        vm.stopPrank();
    }

    /// @dev Register a claimsGroup via scatterDirect so `claimWithProof`
    ///      reaches `_executeClaim` proper.
    function _registerGroup() internal {
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

    // ─── setIdentityGate ─────────────────────────────────────────

    function test_setIdentityGate_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        settlement.setIdentityGate(address(gate));
    }

    function test_setIdentityGate_rejectsNonContract() public {
        vm.expectRevert(PrivateSettlement.NotAContract.selector);
        settlement.setIdentityGate(address(0xDEAD));
    }

    function test_setIdentityGate_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit PrivateSettlement.IdentityGateUpdated(address(0), address(gate));
        settlement.setIdentityGate(address(gate));
        assertEq(address(settlement.identityGate()), address(gate));
    }

    // ─── _executeClaim recipient gating ──────────────────────────

    function test_claim_gated_unverifiedRecipientReverts() public {
        _registerGroup();
        settlement.setIdentityGate(address(gate));
        // bob is not verified.
        vm.expectRevert(PrivateSettlement.NotIdentityVerified.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x01)),
            1 ether, address(token), bob, block.timestamp
        );
    }

    function test_claim_gated_verifiedRecipientSucceeds() public {
        _registerGroup();
        settlement.setIdentityGate(address(gate));
        gate.setVerified(bob, true);

        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x02)),
            1 ether, address(token), bob, block.timestamp
        );
        assertEq(token.balanceOf(bob), 1 ether);
    }

    function test_claim_noGate_unverifiedRecipientSucceeds() public {
        _registerGroup();
        // Gate unset — opt-in check skipped, claim behaves as before.
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x03)),
            1 ether, address(token), bob, block.timestamp
        );
        assertEq(token.balanceOf(bob), 1 ether);
    }

    /// @dev An attestation that lapses before the recipient claims must
    ///      block the claim — mirrors a real registry expiry.
    function test_claim_gated_lapsedRecipientReverts() public {
        _registerGroup();
        settlement.setIdentityGate(address(gate));
        gate.setVerified(bob, true);
        gate.setVerified(bob, false); // attestation lapses

        vm.expectRevert(PrivateSettlement.NotIdentityVerified.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            TEST_CLAIMS_ROOT,
            bytes32(uint256(0x04)),
            1 ether, address(token), bob, block.timestamp
        );
    }
}
