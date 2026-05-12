// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract PsToken is ERC20 {
    constructor() ERC20("Ps", "PS") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @title PrivateSettlementAdminTest
/// @notice Targets the admin / setter / pause branches on PrivateSettlement
///         that the integration suites don't exercise. Not a happy-path
///         settle test — those live in SettleAuth / SettleWithDex.
contract PrivateSettlementAdminTest is Test {
    PrivateSettlement settlement;
    CommitmentPool pool;
    MockWETH weth;
    PsToken token;
    MockClaimVerifier claimVerifier;
    MockAuthorizeVerifier authVerifier;

    address alice = address(0xA11CE);

    function setUp() public {
        MockVerifier withdrawVerifier = new MockVerifier();
        MockDepositVerifier depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();
        weth = new MockWETH();
        token = new PsToken();

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier), address(weth)
        );
    }

    // ─── renounceOwnership / pause / unpause ────────────────────

    function test_renounceOwnership_disabled() public {
        vm.expectRevert(PrivateSettlement.RenounceOwnershipDisabled.selector);
        settlement.renounceOwnership();
    }

    function test_pause_unpause_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        settlement.pause();

        settlement.pause();
        assertTrue(settlement.paused());

        vm.prank(alice);
        vm.expectRevert();
        settlement.unpause();

        settlement.unpause();
        assertFalse(settlement.paused());
    }

    // ─── setTokenWhitelist ──────────────────────────────────────

    function test_setTokenWhitelist_zero_reverts() public {
        vm.expectRevert(PrivateSettlement.ZeroAddress.selector);
        settlement.setTokenWhitelist(address(0), true);
    }

    function test_setTokenWhitelist_toggle() public {
        settlement.setTokenWhitelist(address(token), true);
        assertTrue(settlement.whitelistedTokens(address(token)));
        settlement.setTokenWhitelist(address(token), false);
        assertFalse(settlement.whitelistedTokens(address(token)));
    }

    // ─── setRelayerRegistry ─────────────────────────────────────

    function test_setRelayerRegistry_eoa_reverts() public {
        vm.expectRevert(PrivateSettlement.NotAContract.selector);
        settlement.setRelayerRegistry(alice);
    }

    function test_setRelayerRegistry_zero_disables() public {
        // Wire a contract first, then clear back to address(0).
        settlement.setRelayerRegistry(address(token));
        settlement.setRelayerRegistry(address(0));
        assertEq(address(settlement.relayerRegistry()), address(0));
    }

    // ─── setFeeVault ────────────────────────────────────────────

    function test_setFeeVault_eoa_reverts() public {
        vm.expectRevert(PrivateSettlement.NotAContract.selector);
        settlement.setFeeVault(alice);
    }

    function test_setFeeVault_zero_resets_dexPlatformFee() public {
        // Wire a vault + non-zero fee, then clear the vault and verify the fee
        // bps is reset to 0 (the contract resets it to prevent stuck fee config).
        settlement.setFeeVault(address(token));
        settlement.setDexPlatformFee(50);
        assertEq(settlement.dexPlatformFeeBps(), 50);

        settlement.setFeeVault(address(0));
        assertEq(address(settlement.feeVault()), address(0));
        assertEq(settlement.dexPlatformFeeBps(), 0);
    }

    // ─── setAuthorizeVerifier / setCancelVerifier / setClaimVerifier ────

    function test_setAuthorizeVerifier_eoa_reverts() public {
        vm.expectRevert(PrivateSettlement.NotAContract.selector);
        settlement.setAuthorizeVerifier(16, alice);
    }

    function test_setAuthorizeVerifier_zero_disables() public {
        settlement.setAuthorizeVerifier(16, address(authVerifier));
        assertEq(address(settlement.authorizeVerifierByTier(16)), address(authVerifier));
        settlement.setAuthorizeVerifier(16, address(0));
        assertEq(address(settlement.authorizeVerifierByTier(16)), address(0));
    }

    function test_setCancelVerifier_eoa_reverts() public {
        vm.expectRevert(PrivateSettlement.NotAContract.selector);
        settlement.setCancelVerifier(alice);
    }

    function test_setCancelVerifier_set_and_clear() public {
        settlement.setCancelVerifier(address(authVerifier));
        assertEq(address(settlement.cancelVerifier()), address(authVerifier));
        settlement.setCancelVerifier(address(0));
        assertEq(address(settlement.cancelVerifier()), address(0));
    }

    function test_setClaimVerifier_eoa_reverts() public {
        vm.expectRevert(PrivateSettlement.NotAContract.selector);
        settlement.setClaimVerifier(64, alice);
    }

    function test_setClaimVerifier_zero_disables() public {
        settlement.setClaimVerifier(64, address(claimVerifier));
        assertEq(address(settlement.claimVerifierByTier(64)), address(claimVerifier));
        settlement.setClaimVerifier(64, address(0));
        assertEq(address(settlement.claimVerifierByTier(64)), address(0));
    }

    // ─── setSanctionsList ───────────────────────────────────────

    function test_setSanctionsList_eoa_reverts() public {
        vm.expectRevert(PrivateSettlement.NotAContract.selector);
        settlement.setSanctionsList(alice);
    }

    function test_setSanctionsList_zero_disables() public {
        settlement.setSanctionsList(address(token));
        settlement.setSanctionsList(address(0));
        assertEq(address(settlement.sanctionsList()), address(0));
    }

    // ─── onlyOwner gates on every setter ────────────────────────

    function test_setters_onlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(); settlement.setTokenWhitelist(address(token), true);
        vm.expectRevert(); settlement.setRelayerRegistry(address(token));
        vm.expectRevert(); settlement.setFeeVault(address(token));
        vm.expectRevert(); settlement.setAuthorizeVerifier(16, address(authVerifier));
        vm.expectRevert(); settlement.setCancelVerifier(address(authVerifier));
        vm.expectRevert(); settlement.setClaimVerifier(16, address(claimVerifier));
        vm.expectRevert(); settlement.setSanctionsList(address(token));
        vm.stopPrank();
    }

    // ─── claimWithProof paused / unknown group / wrong recipient ─────

    function test_claimWithProof_paused_reverts() public {
        settlement.pause();
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        settlement.claimWithProof(
            pa, pb, pc, bytes32(uint256(1)), bytes32(uint256(2)),
            1 ether, address(weth), alice, block.timestamp
        );
    }

    function test_claimWithProof_unknownGroup_reverts() public {
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        vm.expectRevert(PrivateSettlement.ClaimsGroupNotFound.selector);
        settlement.claimWithProof(
            pa, pb, pc, bytes32(uint256(0xDEAD)), bytes32(uint256(2)),
            1 ether, address(weth), alice, block.timestamp
        );
    }
}
