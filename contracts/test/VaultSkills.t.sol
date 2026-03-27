// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultSkills} from "../src/VaultSkills.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockRegistry is IIdentityRegistry {
    mapping(address => bool) public verified;

    function setVerified(address user, bool status) external {
        verified[user] = status;
    }

    function isVerified(address user) external view override returns (bool) {
        return verified[user];
    }
}

contract VaultSkillsTest is Test {
    VaultSkills public skills;
    ScatterSettlement public settlement;
    IdentityGate public gate;
    MockRegistry public registry;
    MockToken public tokenA;
    MockToken public tokenB;

    address user = address(0x1234);

    function setUp() public {
        registry = new MockRegistry();
        gate = new IdentityGate(address(registry));
        settlement = new ScatterSettlement(address(gate));
        skills = new VaultSkills();
        tokenA = new MockToken("Token A", "TKA");
        tokenB = new MockToken("Token B", "TKB");

        registry.setVerified(user, true);
        tokenA.mint(user, 100e18);
        tokenB.mint(user, 100e18);
    }

    // ─── EIP-7702 Simulated (delegatecall from EOA context) ─────

    function test_approveAndDeposit_delegated() public {
        // Simulate EIP-7702: set user's code to VaultSkills runtime code
        vm.etch(user, address(skills).code);

        // Call user address which now executes VaultSkills code
        // address(this) inside VaultSkills = user, so approve is from user
        // settlement.deposit msg.sender = user (identity check passes)
        vm.prank(user);
        VaultSkills(user).approveAndDeposit(address(settlement), address(tokenA), 10e18);

        assertEq(settlement.deposits(user, address(tokenA)), 10e18);
        assertEq(tokenA.balanceOf(user), 90e18);
    }

    function test_approveAndDepositMultiple_delegated() public {
        bytes memory skillsCode = address(skills).code;
        vm.etch(user, skillsCode);

        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](2);
        tokens[0] = VaultSkills.TokenAmount({token: address(tokenA), amount: 10e18});
        tokens[1] = VaultSkills.TokenAmount({token: address(tokenB), amount: 20e18});

        vm.prank(user);
        VaultSkills(user).approveAndDepositMultiple(address(settlement), tokens);

        assertEq(settlement.deposits(user, address(tokenA)), 10e18);
        assertEq(settlement.deposits(user, address(tokenB)), 20e18);
        assertEq(tokenA.balanceOf(user), 90e18);
        assertEq(tokenB.balanceOf(user), 80e18);
    }

    function test_withdrawMultiple_delegated() public {
        // First deposit normally
        vm.startPrank(user);
        tokenA.approve(address(settlement), 10e18);
        settlement.deposit(address(tokenA), 10e18);
        tokenB.approve(address(settlement), 20e18);
        settlement.deposit(address(tokenB), 20e18);
        vm.stopPrank();

        // Now etch and withdraw via VaultSkills
        bytes memory skillsCode = address(skills).code;
        vm.etch(user, skillsCode);

        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](2);
        tokens[0] = VaultSkills.TokenAmount({token: address(tokenA), amount: 5e18});
        tokens[1] = VaultSkills.TokenAmount({token: address(tokenB), amount: 10e18});

        vm.prank(user);
        VaultSkills(user).withdrawMultiple(address(settlement), tokens);

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
        VaultSkills(user).approveAndDeposit(address(settlement), address(tokenA), 0);
    }

    function test_approveAndDepositMultiple_empty_reverts() public {
        vm.etch(user, address(skills).code);

        VaultSkills.TokenAmount[] memory tokens = new VaultSkills.TokenAmount[](0);

        vm.prank(user);
        vm.expectRevert(VaultSkills.ArrayEmpty.selector);
        VaultSkills(user).approveAndDepositMultiple(address(settlement), tokens);
    }

    function test_approveAndDeposit_zero_address_reverts() public {
        vm.etch(user, address(skills).code);

        vm.prank(user);
        vm.expectRevert(VaultSkills.ZeroAddress.selector);
        VaultSkills(user).approveAndDeposit(address(0), address(tokenA), 10e18);
    }

    function test_approveAndDeposit_unverified_reverts() public {
        address unverified = address(0x5678);
        tokenA.mint(unverified, 10e18);
        vm.etch(unverified, address(skills).code);

        vm.prank(unverified);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        VaultSkills(unverified).approveAndDeposit(address(settlement), address(tokenA), 10e18);
    }

    // ─── Non-delegated (direct call) ─────────────────────────────

    function test_approveAndDeposit_direct_call() public {
        // User approves VaultSkills to spend tokens
        // VaultSkills approves settlement, but deposit is from VaultSkills not user
        // This means VaultSkills needs to be verified — which it's not
        // So direct call pattern doesn't work with identity gate
        // This is expected: EIP-7702 delegation is the intended usage

        registry.setVerified(address(skills), true);

        vm.prank(user);
        tokenA.transfer(address(skills), 10e18);

        // Skills contract calls deposit — msg.sender = skills
        skills.approveAndDeposit(address(settlement), address(tokenA), 10e18);

        assertEq(settlement.deposits(address(skills), address(tokenA)), 10e18);
    }
}
