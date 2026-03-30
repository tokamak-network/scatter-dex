// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Realistic mock that mirrors zk-X509 IdentityRegistry behavior.
contract RealisticIdentityRegistry is IIdentityRegistry {
    mapping(address => uint64) private _verifiedUntil;
    bool private _paused;

    function setVerifiedUntil(address user, uint64 expiry) external {
        _verifiedUntil[user] = expiry;
    }

    function setPaused(bool paused_) external {
        _paused = paused_;
    }

    function isVerified(address user) external view override returns (bool) {
        return !_paused && _verifiedUntil[user] >= block.timestamp;
    }

    function verifiedUntil(address user) external view override returns (uint64) {
        return _verifiedUntil[user];
    }

    function paused() external view override returns (bool) {
        return _paused;
    }
}

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract IdentityGateTest is Test {
    RealisticIdentityRegistry public registry;
    IdentityGate public gate;
    ScatterSettlement public settlement;
    MockToken public token;

    address user1 = address(0x1111);
    address user2 = address(0x2222);
    address unverified = address(0x3333);

    function setUp() public {
        registry = new RealisticIdentityRegistry();
        gate = new IdentityGate(address(registry));
        // Relayer CA: use a separate mock registry that auto-verifies the test contract
        RealisticIdentityRegistry relayerIdRegistry = new RealisticIdentityRegistry();
        relayerIdRegistry.setVerifiedUntil(address(this), type(uint64).max);
        RelayerRegistry rr = new RelayerRegistry(address(0x7777), address(relayerIdRegistry));
        settlement = new ScatterSettlement(address(gate), address(rr), 0);
        rr.register{value: 0.1 ether}("http://test", 0);
        token = new MockToken();

        settlement.setTokenWhitelist(address(token), true);

        // user1: verified until 30 days from now
        registry.setVerifiedUntil(user1, uint64(block.timestamp + 30 days));

        // user2: verified until 1 hour from now (about to expire)
        registry.setVerifiedUntil(user2, uint64(block.timestamp + 1 hours));

        // unverified: never set (verifiedUntil = 0)

        // Setup token approvals
        token.mint(user1, 100e18);
        token.mint(user2, 100e18);
        token.mint(unverified, 100e18);
        vm.prank(user1);
        token.approve(address(settlement), type(uint256).max);
        vm.prank(user2);
        token.approve(address(settlement), type(uint256).max);
        vm.prank(unverified);
        token.approve(address(settlement), type(uint256).max);
    }

    // ─── IdentityGate Unit Tests ─────────────────────────────────

    function test_constructor_zero_address_reverts() public {
        vm.expectRevert(IdentityGate.RegistryAddressZero.selector);
        new IdentityGate(address(0));
    }

    function test_isVerified_active() public view {
        assertTrue(gate.isVerified(user1));
    }

    function test_isVerified_unverified() public view {
        assertFalse(gate.isVerified(unverified));
    }

    function test_isVerified_expired() public {
        // Fast forward past user2's expiry
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));
    }

    function test_verifiedUntil_returns_expiry() public view {
        uint64 expiry = gate.verifiedUntil(user1);
        assertEq(expiry, uint64(block.timestamp + 30 days));
    }

    function test_verifiedUntil_unverified_returns_zero() public view {
        assertEq(gate.verifiedUntil(unverified), 0);
    }

    function test_isVerified_paused() public {
        assertTrue(gate.isVerified(user1));
        registry.setPaused(true);
        assertFalse(gate.isVerified(user1));
    }

    function test_registry_address() public view {
        assertEq(address(gate.registry()), address(registry));
    }

    // ─── Integration: IdentityGate + ScatterSettlement ───────────

    function test_deposit_verified_user() public {
        vm.prank(user1);
        settlement.deposit(address(token), 10e18);
        assertEq(settlement.deposits(user1, address(token)), 10e18);
    }

    function test_deposit_unverified_reverts() public {
        vm.prank(unverified);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        settlement.deposit(address(token), 10e18);
    }

    function test_deposit_expired_user_reverts() public {
        // user2 is valid now
        vm.prank(user2);
        settlement.deposit(address(token), 5e18);
        assertEq(settlement.deposits(user2, address(token)), 5e18);

        // Fast forward past expiry
        vm.warp(block.timestamp + 2 hours);

        // Now user2 is expired — deposit should fail
        vm.prank(user2);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        settlement.deposit(address(token), 5e18);
    }

    function test_withdraw_still_works_after_expiry() public {
        // Deposit while verified
        vm.prank(user2);
        settlement.deposit(address(token), 10e18);

        // Expire
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));

        // Withdraw should still work (no identity check on withdraw)
        vm.prank(user2);
        settlement.withdraw(address(token), 10e18);
        assertEq(token.balanceOf(user2), 100e18);
    }

    function test_reverify_allows_deposit_again() public {
        // user2 expires
        vm.warp(block.timestamp + 2 hours);
        assertFalse(gate.isVerified(user2));

        vm.prank(user2);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        settlement.deposit(address(token), 5e18);

        // Re-verify with new certificate (new expiry)
        registry.setVerifiedUntil(user2, uint64(block.timestamp + 30 days));
        assertTrue(gate.isVerified(user2));

        // Now deposit works again
        vm.prank(user2);
        settlement.deposit(address(token), 5e18);
        assertEq(settlement.deposits(user2, address(token)), 5e18);
    }

    // ─── E2E: Certificate Expiry During Trade Lifecycle ──────────

    struct TradeEnv {
        ScatterSettlement s;
        address u1;
        address u2;
        uint256 u1Key;
        uint256 u2Key;
        MockToken tA;
        MockToken tB;
    }

    function test_e2e_expiry_during_trade_lifecycle() public {
        // Scenario: user2's certificate expires AFTER deposit + settle,
        // but BEFORE claim time. Claims should still work.
        TradeEnv memory env = _setupTwoTraders(30 days, 1 hours);

        vm.prank(env.u1);
        env.s.deposit(address(env.tA), 10e18);
        vm.prank(env.u2);
        env.s.deposit(address(env.tB), 20e18);

        bytes32 sec1 = keccak256("s1");
        bytes32 sec2 = keccak256("s2");
        address recv1 = address(0xAAA);
        address recv2 = address(0xBBB);

        (ScatterSettlement.Order memory o1, ScatterSettlement.Order memory o2) =
            _buildOrders(env, sec1, recv1, sec2, recv2, 3 hours);

        env.s.settle(
            _signOrder(env.s, env.u1Key, o1),
            _signOrder(env.s, env.u2Key, o2),
            o1, o2, 0
        );

        // user2 expires at t+1h, claims at t+3h
        vm.warp(block.timestamp + 3 hours);

        vm.prank(recv1);
        env.s.claimRelease(sec1);
        assertEq(env.tB.balanceOf(recv1), 20e18);

        vm.prank(recv2);
        env.s.claimRelease(sec2);
        assertEq(env.tA.balanceOf(recv2), 10e18);
    }

    function test_e2e_expired_user_cannot_deposit_but_can_refund() public {
        TradeEnv memory env = _setupTwoTraders(30 days, 1 hours);

        vm.prank(env.u1);
        env.s.deposit(address(env.tA), 10e18);
        vm.prank(env.u2);
        env.s.deposit(address(env.tB), 20e18);

        (ScatterSettlement.Order memory o1, ScatterSettlement.Order memory o2) =
            _buildOrders(env, keccak256("sec1"), address(0xCCC), keccak256("sec2"), address(0xDDD), 2 hours);

        env.s.settle(
            _signOrder(env.s, env.u1Key, o1),
            _signOrder(env.s, env.u2Key, o2),
            o1, o2, 0
        );

        // u2 expires
        vm.warp(block.timestamp + 2 hours);

        // u2 can NOT deposit more
        env.tB.mint(env.u2, 10e18);
        vm.prank(env.u2);
        env.tB.approve(address(env.s), type(uint256).max);
        vm.prank(env.u2);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        env.s.deposit(address(env.tB), 10e18);

        // Nobody claims, wait for refund window
        vm.warp(block.timestamp + 7 days);

        // u2 can still refund + withdraw (no identity check)
        vm.prank(env.u2);
        env.s.refundUnclaimed(keccak256(abi.encodePacked(keccak256("sec2"), address(0xDDD))));
        assertEq(env.s.deposits(env.u2, address(env.tA)), 10e18);

        vm.prank(env.u2);
        env.s.withdraw(address(env.tA), 10e18);
        assertEq(env.tA.balanceOf(env.u2), 10e18);
    }

    // ─── Internal Helpers ────────────────────────────────────────

    function _setupTwoTraders(uint256 expiry1, uint256 expiry2) internal returns (TradeEnv memory env) {
        env.u1Key = 0xB1;
        env.u2Key = 0xB2;
        env.u1 = vm.addr(env.u1Key);
        env.u2 = vm.addr(env.u2Key);

        RealisticIdentityRegistry reg = new RealisticIdentityRegistry();
        IdentityGate g = new IdentityGate(address(reg));
        RealisticIdentityRegistry relayerIdReg = new RealisticIdentityRegistry();
        relayerIdReg.setVerifiedUntil(address(this), type(uint64).max);
        RelayerRegistry rr2 = new RelayerRegistry(address(0x7777), address(relayerIdReg));
        env.s = new ScatterSettlement(address(g), address(rr2), 0);
        rr2.register{value: 0.1 ether}("http://test", 0);

        reg.setVerifiedUntil(env.u1, uint64(block.timestamp + expiry1));
        reg.setVerifiedUntil(env.u2, uint64(block.timestamp + expiry2));

        env.tA = new MockToken();
        env.tB = new MockToken();
        env.s.setTokenWhitelist(address(env.tA), true);
        env.s.setTokenWhitelist(address(env.tB), true);
        env.tA.mint(env.u1, 10e18);
        env.tB.mint(env.u2, 20e18);
        vm.prank(env.u1);
        env.tA.approve(address(env.s), type(uint256).max);
        vm.prank(env.u2);
        env.tB.approve(address(env.s), type(uint256).max);
    }

    function _buildOrders(
        TradeEnv memory env, bytes32 sec1, address recv1, bytes32 sec2, address recv2, uint256 delay
    ) internal view returns (ScatterSettlement.Order memory o1, ScatterSettlement.Order memory o2) {
        ScatterSettlement.ClaimInfo[] memory c1 = new ScatterSettlement.ClaimInfo[](1);
        c1[0] = ScatterSettlement.ClaimInfo({
            claimHash: keccak256(abi.encodePacked(sec1, recv1)),
            amount: 20e18,
            releaseDelay: delay
        });
        o1 = ScatterSettlement.Order({
            maker: env.u1, sellToken: address(env.tA), buyToken: address(env.tB),
            sellAmount: 10e18, buyAmount: 20e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: c1
        });

        ScatterSettlement.ClaimInfo[] memory c2 = new ScatterSettlement.ClaimInfo[](1);
        c2[0] = ScatterSettlement.ClaimInfo({
            claimHash: keccak256(abi.encodePacked(sec2, recv2)),
            amount: 10e18,
            releaseDelay: delay
        });
        o2 = ScatterSettlement.Order({
            maker: env.u2, sellToken: address(env.tB), buyToken: address(env.tA),
            sellAmount: 20e18, buyAmount: 10e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: c2
        });
    }

    // ─── Helper ──────────────────────────────────────────────────

    function _signOrder(ScatterSettlement s, uint256 pk, ScatterSettlement.Order memory order)
        internal
        view
        returns (bytes memory)
    {
        bytes32[] memory claimHashes = new bytes32[](order.claims.length);
        for (uint256 i = 0; i < order.claims.length; i++) {
            claimHashes[i] = keccak256(
                abi.encode(s.CLAIM_INFO_TYPEHASH(), order.claims[i].claimHash, order.claims[i].amount, order.claims[i].releaseDelay)
            );
        }

        bytes32 structHash = keccak256(
            abi.encode(
                s.ORDER_TYPEHASH(), order.maker, order.sellToken, order.buyToken,
                order.sellAmount, order.buyAmount, order.maxFee, order.expiry, order.nonce,
                keccak256(abi.encodePacked(claimHashes))
            )
        );

        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScatterSettlement"), keccak256("1"), block.chainid, address(s)
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, digest);
        return abi.encodePacked(r, ss, v);
    }
}
