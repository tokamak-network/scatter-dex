// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Covers the on-chain zk-X509 identity gate added to CommitmentPool:
///      `deposit` gates the depositor, `withdraw` gates the recipient, and
///      the whole check is opt-in (no gate set → behaves exactly as before).
contract CommitmentPoolIdentityGateTest is Test {
    CommitmentPool public pool;
    MockVerifier public verifier;
    MockDepositVerifier public depositVerifier;
    MockIdentityRegistry public gate;
    MockToken public token;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant COMMITMENT_1 = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    uint256 constant NULLIFIER_1 = 0x0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;

    function setUp() public {
        verifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(verifier), address(depositVerifier), 20, 30
        );
        gate = new MockIdentityRegistry();
        token = new MockToken();

        pool.setTokenWhitelist(address(token), true);
        token.mint(alice, 1000 ether);
        token.mint(bob, 1000 ether);
        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        token.approve(address(pool), type(uint256).max);
    }

    function _deposit(address from, uint256 commitment, uint256 amount) internal {
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        vm.prank(from);
        pool.deposit(pa, pb, pc, commitment, address(token), amount);
    }

    function _withdraw(address recipient, uint256 amount) internal {
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        pool.withdraw(
            pa, pb, pc, pool.getLastRoot(), NULLIFIER_1, 0, address(token), amount, recipient, address(0)
        );
    }

    // ─── setIdentityGate ─────────────────────────────────────────

    function test_setIdentityGate_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.setIdentityGate(address(gate));
    }

    function test_setIdentityGate_rejectsNonContract() public {
        vm.expectRevert(CommitmentPool.NotAContract.selector);
        pool.setIdentityGate(address(0xDEAD));
    }

    function test_setIdentityGate_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit CommitmentPool.IdentityGateUpdated(address(0), address(gate));
        pool.setIdentityGate(address(gate));
        assertEq(address(pool.identityGate()), address(gate));
    }

    function test_setIdentityGate_zeroDisables() public {
        pool.setIdentityGate(address(gate));
        pool.setIdentityGate(address(0));
        assertEq(address(pool.identityGate()), address(0));
    }

    // ─── deposit gating ──────────────────────────────────────────

    function test_deposit_noGate_unverifiedSucceeds() public {
        // Gate unset → opt-in check is skipped, deposit behaves as before.
        _deposit(alice, COMMITMENT_1, 100 ether);
        assertEq(token.balanceOf(address(pool)), 100 ether);
    }

    function test_deposit_gated_unverifiedReverts() public {
        pool.setIdentityGate(address(gate));
        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        vm.prank(alice);
        vm.expectRevert(CommitmentPool.NotIdentityVerified.selector);
        pool.deposit(pa, pb, pc, COMMITMENT_1, address(token), 100 ether);
    }

    function test_deposit_gated_verifiedSucceeds() public {
        pool.setIdentityGate(address(gate));
        gate.setVerified(alice, true);
        _deposit(alice, COMMITMENT_1, 100 ether);
        assertEq(token.balanceOf(address(pool)), 100 ether);
    }

    // ─── withdraw gating (recipient) ─────────────────────────────

    function test_withdraw_gated_unverifiedRecipientReverts() public {
        // alice is verified to get funds in; recipient bob is not.
        pool.setIdentityGate(address(gate));
        gate.setVerified(alice, true);
        _deposit(alice, COMMITMENT_1, 100 ether);

        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        // Hoist the view read — `vm.expectRevert` binds to the *next* call,
        // and an inline `pool.getLastRoot()` arg would consume it instead.
        uint256 root = pool.getLastRoot();
        vm.expectRevert(CommitmentPool.NotIdentityVerified.selector);
        pool.withdraw(pa, pb, pc, root, NULLIFIER_1, 0, address(token), 100 ether, bob, address(0));
    }

    function test_withdraw_gated_verifiedRecipientSucceeds() public {
        pool.setIdentityGate(address(gate));
        gate.setVerified(alice, true);
        gate.setVerified(bob, true);
        _deposit(alice, COMMITMENT_1, 100 ether);

        _withdraw(bob, 100 ether);
        assertEq(token.balanceOf(bob), 1100 ether);
    }

    function test_withdraw_noGate_unverifiedRecipientSucceeds() public {
        _deposit(alice, COMMITMENT_1, 100 ether);
        _withdraw(bob, 100 ether);
        assertEq(token.balanceOf(bob), 1100 ether);
    }

    /// @dev An attestation that lapses between deposit and withdraw must
    ///      block the recipient — `MockIdentityRegistry.isVerified` flips
    ///      with `setVerified`, mirroring an expiry on the real registry.
    function test_withdraw_gated_lapsedRecipientReverts() public {
        pool.setIdentityGate(address(gate));
        gate.setVerified(alice, true);
        gate.setVerified(bob, true);
        _deposit(alice, COMMITMENT_1, 100 ether);

        gate.setVerified(bob, false); // attestation lapses

        uint[2] memory pa;
        uint[2][2] memory pb;
        uint[2] memory pc;
        uint256 root = pool.getLastRoot();
        vm.expectRevert(CommitmentPool.NotIdentityVerified.selector);
        pool.withdraw(pa, pb, pc, root, NULLIFIER_1, 0, address(token), 100 ether, bob, address(0));
    }
}
