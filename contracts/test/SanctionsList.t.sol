// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SanctionsList} from "../src/SanctionsList.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {SettleVerifyLib} from "../src/zk/SettleVerifyLib.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";

contract SLToken is ERC20 {
    constructor() ERC20("Test", "TST") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @title SanctionsListTest
/// @notice Tests for SanctionsList + integration with CommitmentPool and PrivateSettlement.
contract SanctionsListTest is Test {
    SanctionsList sanctions;
    CommitmentPool pool;
    PrivateSettlement settlement;
    MockWETH weth;
    SLToken token;
    MockAuthorizeVerifier authVerifier;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address sanctionedAddr = address(0xBAD);

    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    function setUp() public {
        sanctions = new SanctionsList();

        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        MockClaimVerifier claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        weth = new MockWETH();
        settlement = new PrivateSettlement(
            address(pool), address(claimVerifier), address(weth)
        );
        token = new SLToken();

        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(token), true);
        pool.setAuthorizedSettlement(address(settlement));
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(token), true);
        settlement.setAuthorizeVerifier(16, address(authVerifier));

        // Wire up sanctions
        pool.setSanctionsList(address(sanctions));
        settlement.setSanctionsList(address(sanctions));

        // Sanction the bad address
        sanctions.addSanction(sanctionedAddr);

        // Fund
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 100 ether}();
        weth.transfer(address(pool), 50 ether);
        token.mint(sanctionedAddr, 1000e18);
        token.mint(alice, 1000e18);
    }

    // ─── SanctionsList Unit Tests ───────────────────────────────

    function test_addSanction() public {
        assertTrue(sanctions.isSanctioned(sanctionedAddr));
        assertFalse(sanctions.isSanctioned(alice));
    }

    function test_removeSanction() public {
        sanctions.removeSanction(sanctionedAddr);
        assertFalse(sanctions.isSanctioned(sanctionedAddr));
    }

    function test_batchSanction() public {
        address[] memory addrs = new address[](2);
        addrs[0] = address(0x111);
        addrs[1] = address(0x222);
        sanctions.addSanctionsBatch(addrs);
        assertTrue(sanctions.isSanctioned(address(0x111)));
        assertTrue(sanctions.isSanctioned(address(0x222)));
    }

    function test_addSanction_zeroAddress_reverts() public {
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        sanctions.addSanction(address(0));
    }

    function test_addSanction_duplicate_reverts() public {
        vm.expectRevert(SanctionsList.AlreadySanctioned.selector);
        sanctions.addSanction(sanctionedAddr);
    }

    function test_removeSanction_notSanctioned_reverts() public {
        vm.expectRevert(SanctionsList.NotSanctioned.selector);
        sanctions.removeSanction(alice);
    }

    function test_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        sanctions.addSanction(bob);
    }

    // ─── CommitmentPool Withdraw Integration ────────────────────

    function test_withdraw_sanctionedSender_reverts() public {
        // Sanctioned user cannot call withdraw even with valid proof
        vm.prank(sanctionedAddr);
        vm.expectRevert(CommitmentPool.AddressSanctioned.selector);
        pool.withdraw(proofA, proofB, proofC, 0, 0, 0, address(token), 0, alice, address(0));
    }

    function test_withdraw_sanctionedRecipient_reverts() public {
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.AddressSanctioned.selector);
        pool.withdraw(proofA, proofB, proofC, 0, 0, 0, address(token), 0, sanctionedAddr, address(0));
    }

    // ─── CommitmentPool Integration ─────────────────────────────

    function test_deposit_sanctioned_reverts() public {
        vm.startPrank(sanctionedAddr);
        token.approve(address(pool), 100e18);
        vm.expectRevert(CommitmentPool.AddressSanctioned.selector);
        pool.deposit(proofA, proofB, proofC, uint256(0x1234), address(token), 100e18);
        vm.stopPrank();
    }

    function test_deposit_unsanctioned_succeeds() public {
        vm.startPrank(alice);
        token.approve(address(pool), 100e18);
        pool.deposit(proofA, proofB, proofC, uint256(0x5678), address(token), 100e18);
        vm.stopPrank();
    }

    function test_deposit_sanctioned_after_removal_succeeds() public {
        sanctions.removeSanction(sanctionedAddr);
        vm.startPrank(sanctionedAddr);
        token.approve(address(pool), 100e18);
        pool.deposit(proofA, proofB, proofC, uint256(0x9abc), address(token), 100e18);
        vm.stopPrank();
    }

    function test_deposit_noSanctionsList_succeeds() public {
        pool.setSanctionsList(address(0)); // disable
        vm.startPrank(sanctionedAddr);
        token.approve(address(pool), 100e18);
        pool.deposit(proofA, proofB, proofC, uint256(0xdef0), address(token), 100e18);
        vm.stopPrank();
    }

    // ─── PrivateSettlement Integration ──────────────────────────

    function test_claimWithProof_sanctionedRecipient_reverts() public {
        // Setup: create a claims group first (mock verifier accepts any proof)
        // We can't easily create a real claims group without full settle flow,
        // so we test that the sanctions check happens before the claims group lookup.
        vm.expectRevert(PrivateSettlement.AddressSanctioned.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            bytes32(uint256(0x1111)),
            bytes32(uint256(0x2222)),
            1 ether,
            address(weth),
            sanctionedAddr, // sanctioned recipient
            block.timestamp
        );
    }

    function test_settleWithDex_sanctionedUser_reverts() public {
        // Setup DEX router (use authVerifier as a real contract address)
        settlement.setDexRouterWhitelist(address(authVerifier), true);

        PrivateSettlement.SettleDexParams memory p = PrivateSettlement.SettleDexParams({
            proof: SettleVerifyLib.AuthorizeProof({
                proofA: proofA, proofB: proofB, proofC: proofC,
                pubKeyBind: bytes32(0), commitmentRoot: pool.getLastRoot(),
                nullifier: bytes32(uint256(0x11)), nonceNullifier: bytes32(uint256(0x22)),
                newCommitment: bytes32(uint256(0x33)),
                sellToken: address(weth), buyToken: address(token),
                sellAmount: 1 ether, buyAmount: 0, maxFee: 0,
                expiry: uint64(block.timestamp + 3600),
                claimsRoot: bytes32(uint256(0x44)), totalLocked: 1 ether,
                relayer: sanctionedAddr, orderHash: bytes32(uint256(0x55)),
                tier: 16
            }),
            dexRouter: address(authVerifier),
            dexCalldata: "", deadline: block.timestamp + 1800
        });

        vm.prank(sanctionedAddr);
        vm.expectRevert(PrivateSettlement.AddressSanctioned.selector);
        settlement.settleWithDex(p);
    }
}
