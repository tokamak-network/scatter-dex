// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {SettleVerifyLib} from "../src/zk/SettleVerifyLib.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";

contract PoCToken is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title CrossContractNullifierDoubleSpendRegression
/// @notice Regression guard for the CRITICAL cross-contract nullifier
///         double-spend. WITHOUT the fix, one deposited escrow note could be
///         spent TWICE — once via `CommitmentPool.withdraw` (marks
///         `CommitmentPool.nullifiers`) and once via a settlement path like
///         `scatterDirectAuth` (marked only the SEPARATE
///         `PrivateSettlement.nullifiers`), because both circuits derive the
///         same escrow nullifier `N = Poseidon(TAG_ESCROW_NULL, secret, salt)`
///         but the two contracts never consulted each other's spent-set.
///
///         The fix routes every settlement-side escrow spend through
///         `CommitmentPool.spendEscrowNullifier`, making the pool's set the
///         single source of truth. These tests assert the second spend now
///         reverts in BOTH orders (settle→withdraw and withdraw→settle).
///
///         The mock verifiers accept any proof — faithful here because the
///         bug is in nullifier accounting, not proof verification: a real
///         prover holding the note's secret + EdDSA key produces two
///         genuinely-valid proofs carrying the SAME nullifier value, exactly
///         what these mocks let us drive directly.
contract CrossContractNullifierDoubleSpendRegression is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    MockVerifier public withdrawVerifier;
    MockDepositVerifier public depositVerifier;
    MockClaimVerifier public claimVerifier;
    MockAuthorizeVerifier public authVerifier;
    MockWETH public weth;
    PoCToken public usdc;

    address attacker = address(0xA77ACA);

    // The single escrow nullifier value. The withdraw circuit and the
    // authorize circuit emit THIS SAME value for the attacker's one note
    // (both compute Poseidon(TAG_ESCROW_NULL=0, secret, salt)). On-chain it
    // is keyed as uint256 in the pool and as bytes32 in the settlement —
    // same number, two unsynced mappings.
    uint256 constant N = 0xDEADBEEFCAFE;

    uint256 constant DEPOSIT = 100 ether; // attacker's own note
    uint256 constant OTHERS = 1_000_000 ether; // other depositors' pooled funds

    function setUp() public {
        withdrawVerifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();

        pool = ProxyDeployer.deployCommitmentPool(
            address(this), address(this), address(withdrawVerifier), address(depositVerifier), 20, 30
        );
        weth = new MockWETH();
        settlement = ProxyDeployer.deployPrivateSettlement(
            address(this), address(this), address(pool), address(claimVerifier), address(weth)
        );
        usdc = new PoCToken();

        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(usdc), true);
        pool.setAuthorizedSettlement(address(settlement));
        settlement.setAuthorizeVerifier(16, address(authVerifier));

        // Other honest depositors' funds already sit in the pool.
        usdc.mint(address(pool), OTHERS);
        // The attacker's own deposit balance.
        usdc.mint(attacker, DEPOSIT);
    }

    /// @dev Deposit one note and return the pool root that contains it.
    function _depositNote(uint256 commitment) internal returns (uint256 root) {
        uint256[2] memory pa;
        uint256[2][2] memory pb;
        uint256[2] memory pc;
        vm.startPrank(attacker);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(pa, pb, pc, commitment, address(usdc), DEPOSIT);
        vm.stopPrank();
        return pool.getLastRoot();
    }

    function _scatterAp(uint256 root) internal view returns (SettleVerifyLib.AuthorizeProof memory) {
        uint256[2] memory pa;
        uint256[2][2] memory pb;
        uint256[2] memory pc;
        return SettleVerifyLib.AuthorizeProof({
            proofA: pa,
            proofB: pb,
            proofC: pc,
            pubKeyBind: bytes32(uint256(0xB1)),
            commitmentRoot: root,
            nullifier: bytes32(N), // SAME escrow nullifier the withdraw uses
            nonceNullifier: bytes32(uint256(0xACE1)),
            newCommitment: bytes32(0),
            sellToken: address(usdc),
            buyToken: address(usdc), // direct scatter: sell == buy
            sellAmount: uint128(DEPOSIT),
            buyAmount: uint128(DEPOSIT),
            maxFee: 0,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: bytes32(uint256(0xCA11)),
            totalLocked: uint128(DEPOSIT),
            relayer: attacker, // attacker self-relays
            orderHash: bytes32(uint256(0x0DE4)),
            tier: 16
        });
    }

    function _withdraw(uint256 root, address recipient) internal {
        uint256[2] memory pa;
        uint256[2][2] memory pb;
        uint256[2] memory pc;
        pool.withdraw(pa, pb, pc, root, /*nullifierHash*/ N, /*newCommitment*/ 0, address(usdc), DEPOSIT, recipient, address(0));
    }

    /// @notice REGRESSION: after the fix, spending the note via the settlement
    ///         path burns the escrow nullifier in the POOL's set too, so a
    ///         follow-up `withdraw` of the same note reverts — no double-spend.
    function test_fix_withdrawAfterSettle_reverts() public {
        uint256 root = _depositNote(uint256(0xC0FFEE));

        // SPEND #1 — scatterDirectAuth. Now also burns pool.nullifiers[N].
        vm.prank(attacker);
        settlement.scatterDirectAuth(PrivateSettlement.ScatterDirectAuthParams({proof: _scatterAp(root), fee: 0}));
        assertTrue(pool.nullifiers(N), "fix: settle now burns the pool escrow nullifier");

        // SPEND #2 — withdraw the same note → must revert.
        vm.expectRevert(CommitmentPool.NullifierAlreadySpent.selector);
        _withdraw(root, attacker);

        // Pool only lost the single legitimate 100 (to settlement), not 200.
        assertEq(usdc.balanceOf(address(pool)), OTHERS, "no drain: only the one settle moved funds");
    }

    /// @notice REGRESSION (reverse order): withdraw first burns pool.nullifiers[N];
    ///         the settlement path then reverts when it tries to burn the same
    ///         escrow nullifier in the pool.
    function test_fix_settleAfterWithdraw_reverts() public {
        uint256 root = _depositNote(uint256(0xC0FFEE));

        // SPEND #1 — withdraw. Burns pool.nullifiers[N].
        _withdraw(root, attacker);
        assertTrue(pool.nullifiers(N));
        assertEq(usdc.balanceOf(attacker), DEPOSIT, "attacker got their own 100 back");

        // SPEND #2 — scatterDirectAuth same note → reverts inside pool.spendEscrowNullifier.
        vm.prank(attacker);
        vm.expectRevert(CommitmentPool.NullifierAlreadySpent.selector);
        settlement.scatterDirectAuth(PrivateSettlement.ScatterDirectAuthParams({proof: _scatterAp(root), fee: 0}));

        // Pool only lost the single legitimate 100 (the withdraw); no second extraction.
        assertEq(usdc.balanceOf(address(pool)), OTHERS, "no drain: settle blocked");
        assertEq(usdc.balanceOf(address(settlement)), 0, "settlement never received the second 100");
    }
}
