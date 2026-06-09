// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

/// @title FeeVaultWethUnwrap
/// @notice Covers the opt-in WETH→ETH unwrap path via `claimAsEth()`.
contract FeeVaultWethUnwrapTest is Test {
    FeeVault internal vault;
    MockWETH internal weth;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xCAFE);
    address internal depositor = address(0xDEAD); // stands in for PrivateSettlement
    address internal relayer;

    function setUp() public {
        vault = ProxyDeployer.deployFeeVault(address(this), owner, treasury, 500); // 5%
        weth = new MockWETH();
        relayer = makeAddr("relayer");
        vm.prank(owner);
        vault.setWeth(address(weth));
        vm.prank(owner);
        vault.setAuthorizedDepositor(depositor, true);
    }

    /// @dev Credit a relayer balance by minting WETH directly to the
    ///      vault then calling `deposit` from an authorized depositor.
    function _creditRelayer(uint256 amount) internal {
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(vault), amount);
        vm.prank(depositor);
        vault.deposit(relayer, address(weth), amount);
    }

    // ─────────────────────────────────────────────────────────────

    function test_setWeth_setsAndClearsTheSlot() public {
        vm.prank(owner);
        vault.setWeth(address(0));
        assertEq(vault.weth(), address(0), "weth cleared");

        vm.prank(owner);
        vault.setWeth(address(weth));
        assertEq(vault.weth(), address(weth), "weth restored");
    }

    function test_setWeth_emitsWethUpdated() public {
        vm.prank(owner);
        vault.setWeth(address(0));
        vm.expectEmit(true, true, true, true, address(vault));
        emit FeeVault.WethUpdated(address(0), address(weth));
        vm.prank(owner);
        vault.setWeth(address(weth));
    }

    function test_setWeth_rejectsNonOwner() public {
        vm.expectRevert();
        vault.setWeth(address(weth));
    }

    function test_setWeth_rejectsEOA() public {
        address eoa = makeAddr("eoa-with-no-code");
        vm.prank(owner);
        vm.expectRevert(FeeVault.NotAContract.selector);
        vault.setWeth(eoa);
    }

    function test_claimAsEth_pays_relayer_and_treasury_in_eth() public {
        _creditRelayer(1 ether);

        uint256 relayerEthBefore = relayer.balance;
        uint256 treasuryEthBefore = treasury.balance;
        uint256 vaultWethBefore = weth.balanceOf(address(vault));
        assertEq(vaultWethBefore, 1 ether, "vault holds the WETH pre-claim");

        vm.prank(relayer);
        vault.claimAsEth(address(weth));

        // 5% fee = 0.05 ETH → treasury; 95% = 0.95 ETH → relayer.
        assertEq(treasury.balance - treasuryEthBefore, 0.05 ether, "treasury ETH delta");
        assertEq(relayer.balance - relayerEthBefore, 0.95 ether, "relayer ETH delta");

        // Vault should hold zero WETH and zero ETH after the unwrap.
        assertEq(weth.balanceOf(address(vault)), 0, "vault WETH drained");
        assertEq(address(vault).balance, 0, "vault ETH zero");

        // Relayer balance entry zeroed; totalTracked decremented.
        assertEq(vault.balances(relayer, address(weth)), 0, "balance zeroed");
        assertEq(vault.totalTracked(address(weth)), 0, "totalTracked zeroed");
    }

    function test_claimAsEth_reverts_when_weth_unset() public {
        _creditRelayer(1 ether);
        vm.prank(owner);
        vault.setWeth(address(0));

        vm.prank(relayer);
        vm.expectRevert(FeeVault.WethNotConfigured.selector);
        vault.claimAsEth(address(weth));
    }

    function test_claimAsEth_reverts_for_non_weth_token() public {
        MockWETH otherToken = new MockWETH();
        vm.prank(relayer);
        vm.expectRevert(FeeVault.WrongClaimToken.selector);
        vault.claimAsEth(address(otherToken));
    }

    function test_claim_weth_still_pays_erc20_for_contract_relayers() public {
        // Smart-contract relayers without payable receive() MUST keep
        // using `claim()` — the original ERC20 path. Verify that
        // calling `claim(weth)` after `setWeth(weth)` does NOT unwrap.
        _creditRelayer(1 ether);
        uint256 relayerEthBefore = relayer.balance;

        vm.prank(relayer);
        vault.claim(address(weth));

        assertEq(relayer.balance, relayerEthBefore, "no ETH for plain claim");
        assertEq(weth.balanceOf(relayer), 0.95 ether, "relayer got WETH");
        assertEq(weth.balanceOf(treasury), 0.05 ether, "treasury got WETH");
    }

    function test_receive_reverts_for_non_weth_sender() public {
        vm.deal(address(this), 1 ether);
        // Direct ETH from a random EOA must NOT stick on the vault.
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "receive() must reject non-WETH senders");
    }

    function test_claimAsEth_zero_platform_fee_only_pays_relayer() public {
        // Schedule + apply a 0-bps fee so the fee branch is exercised
        // with platformFee == 0.
        vm.prank(owner);
        vault.scheduleFeeChange(0);
        vm.warp(block.timestamp + vault.feeChangeDelay());
        vm.prank(owner);
        vault.applyFeeChange();
        assertEq(vault.platformFeeBps(), 0, "fee set to 0");

        _creditRelayer(1 ether);
        uint256 relayerEthBefore = relayer.balance;
        uint256 treasuryEthBefore = treasury.balance;

        vm.prank(relayer);
        vault.claimAsEth(address(weth));

        assertEq(relayer.balance - relayerEthBefore, 1 ether, "relayer got full 1 ETH");
        assertEq(treasury.balance, treasuryEthBefore, "treasury unchanged");
    }
}
