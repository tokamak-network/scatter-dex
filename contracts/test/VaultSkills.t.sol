// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultSkills} from "../src/VaultSkills.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract VaultSkillsTest is Test {
    VaultSkills public skills;
    ScatterSettlement public settlement;
    IdentityGate public gate;
    MockIdentityRegistry public registry;
    MockToken public tokenA;
    MockToken public tokenB;

    address user = address(0x1234);

    function setUp() public {
        registry = new MockIdentityRegistry();
        gate = new IdentityGate(address(registry));
        MockIdentityRegistry relayerIdRegistry = new MockIdentityRegistry();
        relayerIdRegistry.setVerified(address(this), true);
        RelayerRegistry rr = new RelayerRegistry(address(0x7777), address(relayerIdRegistry));
        settlement = new ScatterSettlement(address(gate), address(rr), 0);
        rr.register{value: 0.1 ether}("http://test", 0);
        skills = new VaultSkills();
        tokenA = new MockToken("Token A", "TKA");
        tokenB = new MockToken("Token B", "TKB");

        settlement.setTokenWhitelist(address(tokenA), true);
        settlement.setTokenWhitelist(address(tokenB), true);

        registry.setVerified(user, true);
        tokenA.mint(user, 100e18);
        tokenB.mint(user, 100e18);
    }

    // ─── EIP-7702 Simulated (delegatecall from EOA context) ─────

    function test_approveAndDeposit_delegated() public {
        vm.etch(user, address(skills).code);

        vm.prank(user);
        VaultSkills(payable(user)).approveAndDeposit(address(settlement), address(tokenA), 10e18);

        assertEq(settlement.deposits(user, address(tokenA)), 10e18);
        assertEq(tokenA.balanceOf(user), 90e18);
        // Verify allowance is revoked after deposit
        assertEq(tokenA.allowance(user, address(settlement)), 0, "allowance should be 0 after deposit");
    }

    function test_approveAndDepositMultiple_delegated() public {
        vm.etch(user, address(skills).code);

        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](2);
        tokens[0] = VaultSkills.TokenAmount({token: address(tokenA), amount: 10e18});
        tokens[1] = VaultSkills.TokenAmount({token: address(tokenB), amount: 20e18});

        vm.prank(user);
        VaultSkills(payable(user)).approveAndDepositMultiple(address(settlement), tokens);

        assertEq(settlement.deposits(user, address(tokenA)), 10e18);
        assertEq(settlement.deposits(user, address(tokenB)), 20e18);
        assertEq(tokenA.balanceOf(user), 90e18);
        assertEq(tokenB.balanceOf(user), 80e18);
        // Verify allowances revoked
        assertEq(tokenA.allowance(user, address(settlement)), 0, "tokenA allowance should be 0");
        assertEq(tokenB.allowance(user, address(settlement)), 0, "tokenB allowance should be 0");
    }

    function test_withdrawMultiple_delegated() public {
        vm.startPrank(user);
        tokenA.approve(address(settlement), 10e18);
        settlement.deposit(address(tokenA), 10e18);
        tokenB.approve(address(settlement), 20e18);
        settlement.deposit(address(tokenB), 20e18);
        vm.stopPrank();

        vm.etch(user, address(skills).code);

        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](2);
        tokens[0] = VaultSkills.TokenAmount({token: address(tokenA), amount: 5e18});
        tokens[1] = VaultSkills.TokenAmount({token: address(tokenB), amount: 10e18});

        vm.prank(user);
        VaultSkills(payable(user)).withdrawMultiple(address(settlement), tokens);

        assertEq(settlement.deposits(user, address(tokenA)), 5e18);
        assertEq(settlement.deposits(user, address(tokenB)), 10e18);
        assertEq(tokenA.balanceOf(user), 95e18);
        assertEq(tokenB.balanceOf(user), 90e18);
    }

    // ─── Edge Cases ──────────────────────────────────────────────

    function test_approveAndDeposit_zero_reverts() public {
        vm.etch(user, address(skills).code);
        vm.prank(user);
        vm.expectRevert(VaultSkills.ZeroAmount.selector);
        VaultSkills(payable(user)).approveAndDeposit(address(settlement), address(tokenA), 0);
    }

    function test_approveAndDepositMultiple_empty_reverts() public {
        vm.etch(user, address(skills).code);
        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](0);
        vm.prank(user);
        vm.expectRevert(VaultSkills.ArrayEmpty.selector);
        VaultSkills(payable(user)).approveAndDepositMultiple(address(settlement), tokens);
    }

    function test_approveAndDeposit_zero_address_reverts() public {
        vm.etch(user, address(skills).code);
        vm.prank(user);
        vm.expectRevert(VaultSkills.ZeroAddress.selector);
        VaultSkills(payable(user)).approveAndDeposit(address(0), address(tokenA), 10e18);
    }

    function test_approveAndDeposit_unverified_reverts() public {
        address unverified = address(0x5678);
        tokenA.mint(unverified, 10e18);
        vm.etch(unverified, address(skills).code);
        vm.prank(unverified);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        VaultSkills(payable(unverified)).approveAndDeposit(address(settlement), address(tokenA), 10e18);
    }

    // ─── withdrawMultiple revert tests ───────────────────────────

    function test_withdrawMultiple_zero_address_reverts() public {
        vm.etch(user, address(skills).code);
        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](1);
        tokens[0] = VaultSkills.TokenAmount({token: address(tokenA), amount: 5e18});
        vm.prank(user);
        vm.expectRevert(VaultSkills.ZeroAddress.selector);
        VaultSkills(payable(user)).withdrawMultiple(address(0), tokens);
    }

    function test_withdrawMultiple_empty_reverts() public {
        vm.etch(user, address(skills).code);
        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](0);
        vm.prank(user);
        vm.expectRevert(VaultSkills.ArrayEmpty.selector);
        VaultSkills(payable(user)).withdrawMultiple(address(settlement), tokens);
    }

    function test_withdrawMultiple_zero_amount_reverts() public {
        vm.etch(user, address(skills).code);
        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](1);
        tokens[0] = VaultSkills.TokenAmount({token: address(tokenA), amount: 0});
        vm.prank(user);
        vm.expectRevert(VaultSkills.ZeroAmount.selector);
        VaultSkills(payable(user)).withdrawMultiple(address(settlement), tokens);
    }

    // ─── Non-delegated (direct call) ─────────────────────────────

    function test_approveAndDeposit_direct_call() public {
        // Direct call (non-delegated): VaultSkills contract itself is the caller.
        // msg.sender to settlement = address(skills), NOT the user.
        // This only works if VaultSkills address is verified AND holds the tokens.
        // This is NOT the intended EIP-7702 flow — shown here for completeness.

        registry.setVerified(address(skills), true);

        vm.prank(user);
        tokenA.transfer(address(skills), 10e18);

        skills.approveAndDeposit(address(settlement), address(tokenA), 10e18);

        // Deposit is credited to VaultSkills contract, not the user
        assertEq(settlement.deposits(address(skills), address(tokenA)), 10e18);
    }
}
