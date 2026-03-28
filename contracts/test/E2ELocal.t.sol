// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockRegistry is IIdentityRegistry {
    mapping(address => bool) public verified;
    function setVerified(address u, bool v) external { verified[u] = v; }
    function isVerified(address u) external view override returns (bool) { return verified[u]; }
    function verifiedUntil(address) external pure override returns (uint64) { return type(uint64).max; }
    function paused() external pure override returns (bool) { return false; }
}

contract E2ELocalTest is Test {
    ScatterSettlement settlement;
    RelayerRegistry relayerRegistry;
    IdentityGate gate;
    MockRegistry idRegistry;
    MockToken weth;
    MockToken usdc;
    MockToken dai;

    // 5 traders
    uint256 aliceKey = 0xA1;
    uint256 bobKey = 0xA2;
    uint256 charlieKey = 0xA3;
    uint256 dianaKey = 0xA4;
    uint256 eveKey = 0xA5;
    address alice; address bob; address charlie; address diana; address eve;

    // 2 relayers
    address relayer1 = address(0xAA01);
    address relayer2 = address(0xAA02);

    // recipients
    address recv1 = address(0xC1);
    address recv2 = address(0xC2);
    address recv3 = address(0xC3);
    address recv4 = address(0xC4);
    address recv5 = address(0xC5);
    address recv6 = address(0xC6);

    address treasury = address(0x7777);

    bytes32 s1 = keccak256("secret1");
    bytes32 s2 = keccak256("secret2");
    bytes32 s3 = keccak256("secret3");
    bytes32 s4 = keccak256("secret4");
    bytes32 s5 = keccak256("secret5");
    bytes32 s6 = keccak256("secret6");

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        charlie = vm.addr(charlieKey);
        diana = vm.addr(dianaKey);
        eve = vm.addr(eveKey);

        idRegistry = new MockRegistry();
        gate = new IdentityGate(address(idRegistry));
        relayerRegistry = new RelayerRegistry(treasury);
        settlement = new ScatterSettlement(address(gate), address(relayerRegistry), 1000); // 10% protocol fee

        weth = new MockToken("WETH", "WETH");
        usdc = new MockToken("USDC", "USDC");
        dai = new MockToken("DAI", "DAI");

        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(dai), true);

        // Verify all traders
        address[5] memory traders = [alice, bob, charlie, diana, eve];
        for (uint i; i < 5; i++) {
            idRegistry.setVerified(traders[i], true);
            weth.mint(traders[i], 1000 ether);
            usdc.mint(traders[i], 1_000_000e18);
            dai.mint(traders[i], 1_000_000e18);
            vm.startPrank(traders[i]);
            weth.approve(address(settlement), type(uint256).max);
            usdc.approve(address(settlement), type(uint256).max);
            dai.approve(address(settlement), type(uint256).max);
            vm.stopPrank();
        }

        // Register 2 relayers
        vm.deal(relayer1, 10 ether);
        vm.deal(relayer2, 10 ether);
        vm.prank(relayer1);
        relayerRegistry.register{value: 1 ether}("http://relayer1", 30);
        vm.prank(relayer2);
        relayerRegistry.register{value: 0.5 ether}("http://relayer2", 20);
    }

    // ─── Helper ──────────────────────────────────────────────────

    function _claimHash(bytes32 secret, address recipient) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(secret, recipient));
    }

    function _signOrder(uint256 pk, ScatterSettlement.Order memory order) internal view returns (bytes memory) {
        bytes32[] memory ch = new bytes32[](order.claims.length);
        for (uint i; i < order.claims.length; i++) {
            ch[i] = keccak256(abi.encode(
                settlement.CLAIM_INFO_TYPEHASH(), order.claims[i].claimHash,
                order.claims[i].amount, order.claims[i].releaseDelay
            ));
        }
        bytes32 structHash = keccak256(abi.encode(
            settlement.ORDER_TYPEHASH(), order.maker, order.sellToken, order.buyToken,
            order.sellAmount, order.buyAmount, order.maxFee, order.expiry, order.nonce,
            keccak256(abi.encodePacked(ch))
        ));
        bytes32 domainSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("ScatterSettlement"), keccak256("1"), block.chainid, address(settlement)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, digest);
        return abi.encodePacked(r, ss, v);
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST 1: Multi-party trade — Alice↔Bob WETH/USDC with 3 recipients
    // ═══════════════════════════════════════════════════════════════

    function test_e2e_multiParty_trade() public {
        // Alice deposits 10 WETH, Bob deposits 21000 USDC
        vm.prank(alice);
        settlement.deposit(address(weth), 10 ether);
        vm.prank(bob);
        settlement.deposit(address(usdc), 21_000e18);

        // Alice order: sell 10 WETH, buy 21000 USDC, 3 recipients, fee 30bp
        ScatterSettlement.ClaimInfo[] memory ac = new ScatterSettlement.ClaimInfo[](3);
        uint256 aliceFee = (21_000e18 * 30) / 10000; // 63 USDC
        uint256 aliceDistrib = 21_000e18 - aliceFee;
        ac[0] = ScatterSettlement.ClaimInfo(_claimHash(s1, recv1), 7000e18, 3 hours);
        ac[1] = ScatterSettlement.ClaimInfo(_claimHash(s2, recv2), 8000e18, 6 hours);
        ac[2] = ScatterSettlement.ClaimInfo(_claimHash(s3, recv3), aliceDistrib - 7000e18 - 8000e18, 9 hours);

        ScatterSettlement.Order memory ao = ScatterSettlement.Order({
            maker: alice, sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 30,
            expiry: block.timestamp + 1 days, nonce: 1, claims: ac
        });

        // Bob order: sell 21000 USDC, buy 10 WETH, 1 recipient
        ScatterSettlement.ClaimInfo[] memory bc = new ScatterSettlement.ClaimInfo[](1);
        uint256 bobFee = (10 ether * 30) / 10000;
        bc[0] = ScatterSettlement.ClaimInfo(_claimHash(s4, recv4), 10 ether - bobFee, 4 hours);

        ScatterSettlement.Order memory bo = ScatterSettlement.Order({
            maker: bob, sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 30,
            expiry: block.timestamp + 1 days, nonce: 1, claims: bc
        });

        // Relayer 1 settles (sign before prank to avoid prank consumption by view calls)
        bytes memory sigA = _signOrder(aliceKey, ao);
        bytes memory sigB = _signOrder(bobKey, bo);
        vm.prank(relayer1);
        settlement.settle(sigA, sigB, ao, bo, 30);

        // Verify escrows depleted
        assertEq(settlement.deposits(alice, address(weth)), 0);
        assertEq(settlement.deposits(bob, address(usdc)), 0);
        // Verify fee split (10% protocol, 90% relayer)
        uint256 wethProtocol = (bobFee * 1000) / 10000;
        uint256 usdcProtocol = (aliceFee * 1000) / 10000;
        assertEq(weth.balanceOf(treasury), wethProtocol, "treasury WETH");
        assertEq(usdc.balanceOf(treasury), usdcProtocol, "treasury USDC");
        assertEq(weth.balanceOf(relayer1), bobFee - wethProtocol, "relayer1 WETH");
        assertEq(usdc.balanceOf(relayer1), aliceFee - usdcProtocol, "relayer1 USDC");

        // Time-delayed claims
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 3 hours);
        vm.prank(recv1);
        settlement.claimRelease(s1);
        assertEq(usdc.balanceOf(recv1), 7000e18);

        vm.warp(t0 + 4 hours);
        vm.prank(recv4);
        settlement.claimRelease(s4);
        assertEq(weth.balanceOf(recv4), 10 ether - bobFee);

        vm.warp(t0 + 6 hours);
        vm.prank(recv2);
        settlement.claimRelease(s2);
        assertEq(usdc.balanceOf(recv2), 8000e18);

        vm.warp(t0 + 9 hours);
        vm.prank(recv3);
        settlement.claimRelease(s3);

        // Conservation check
        uint256 totalUsdc = usdc.balanceOf(recv1) + usdc.balanceOf(recv2) + usdc.balanceOf(recv3)
            + usdc.balanceOf(relayer1) + usdc.balanceOf(treasury);
        assertEq(totalUsdc, 21_000e18, "USDC conservation");
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST 2: Concurrent trades — 2 independent trades, different relayers
    // ═══════════════════════════════════════════════════════════════

    function test_e2e_concurrent_trades_different_relayers() public {
        // Trade 1: Alice↔Bob via relayer1 (WETH/USDC)
        // Trade 2: Charlie↔Diana via relayer2 (WETH/DAI)

        vm.prank(alice);  settlement.deposit(address(weth), 5 ether);
        vm.prank(bob);    settlement.deposit(address(usdc), 10_500e18);
        vm.prank(charlie); settlement.deposit(address(weth), 3 ether);
        vm.prank(diana);  settlement.deposit(address(dai), 6_300e18);

        // Trade 1: Alice sells 5 WETH for 10500 USDC
        ScatterSettlement.ClaimInfo[] memory c1a = new ScatterSettlement.ClaimInfo[](1);
        c1a[0] = ScatterSettlement.ClaimInfo(_claimHash(s1, recv1), 10_500e18, 2 hours);
        ScatterSettlement.Order memory o1a = ScatterSettlement.Order({
            maker: alice, sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 5 ether, buyAmount: 10_500e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 10, claims: c1a
        });

        ScatterSettlement.ClaimInfo[] memory c1b = new ScatterSettlement.ClaimInfo[](1);
        c1b[0] = ScatterSettlement.ClaimInfo(_claimHash(s2, recv2), 5 ether, 3 hours);
        ScatterSettlement.Order memory o1b = ScatterSettlement.Order({
            maker: bob, sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 10_500e18, buyAmount: 5 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 10, claims: c1b
        });

        // Trade 2: Charlie sells 3 WETH for 6300 DAI
        ScatterSettlement.ClaimInfo[] memory c2a = new ScatterSettlement.ClaimInfo[](1);
        c2a[0] = ScatterSettlement.ClaimInfo(_claimHash(s3, recv3), 6_300e18, 4 hours);
        ScatterSettlement.Order memory o2a = ScatterSettlement.Order({
            maker: charlie, sellToken: address(weth), buyToken: address(dai),
            sellAmount: 3 ether, buyAmount: 6_300e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 10, claims: c2a
        });

        ScatterSettlement.ClaimInfo[] memory c2b = new ScatterSettlement.ClaimInfo[](1);
        c2b[0] = ScatterSettlement.ClaimInfo(_claimHash(s4, recv4), 3 ether, 5 hours);
        ScatterSettlement.Order memory o2b = ScatterSettlement.Order({
            maker: diana, sellToken: address(dai), buyToken: address(weth),
            sellAmount: 6_300e18, buyAmount: 3 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 10, claims: c2b
        });

        // Different relayers settle
        bytes memory s1a = _signOrder(aliceKey, o1a);
        bytes memory s1b = _signOrder(bobKey, o1b);
        bytes memory s2a = _signOrder(charlieKey, o2a);
        bytes memory s2b = _signOrder(dianaKey, o2b);
        vm.prank(relayer1);
        settlement.settle(s1a, s1b, o1a, o1b, 0);
        vm.prank(relayer2);
        settlement.settle(s2a, s2b, o2a, o2b, 0);

        // Claims at different times
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 2 hours);
        vm.prank(recv1); settlement.claimRelease(s1);
        vm.warp(t0 + 3 hours);
        vm.prank(recv2); settlement.claimRelease(s2);
        vm.warp(t0 + 4 hours);
        vm.prank(recv3); settlement.claimRelease(s3);
        vm.warp(t0 + 5 hours);
        vm.prank(recv4); settlement.claimRelease(s4);

        assertEq(usdc.balanceOf(recv1), 10_500e18);
        assertEq(weth.balanceOf(recv2), 5 ether);
        assertEq(dai.balanceOf(recv3), 6_300e18);
        assertEq(weth.balanceOf(recv4), 3 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST 3: Multi-relayer nonce race — same order to 2 relayers
    // ═══════════════════════════════════════════════════════════════

    function test_e2e_multiRelayer_nonce_race() public {
        vm.prank(alice); settlement.deposit(address(weth), 5 ether);
        vm.prank(bob);   settlement.deposit(address(usdc), 10_500e18);

        ScatterSettlement.ClaimInfo[] memory ca = new ScatterSettlement.ClaimInfo[](1);
        ca[0] = ScatterSettlement.ClaimInfo(_claimHash(s1, recv1), 10_500e18, 1 hours);
        ScatterSettlement.Order memory oa = ScatterSettlement.Order({
            maker: alice, sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 5 ether, buyAmount: 10_500e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 99, claims: ca
        });

        ScatterSettlement.ClaimInfo[] memory cb = new ScatterSettlement.ClaimInfo[](1);
        cb[0] = ScatterSettlement.ClaimInfo(_claimHash(s2, recv2), 5 ether, 1 hours);
        ScatterSettlement.Order memory ob = ScatterSettlement.Order({
            maker: bob, sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 10_500e18, buyAmount: 5 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 99, claims: cb
        });

        bytes memory sigA = _signOrder(aliceKey, oa);
        bytes memory sigB = _signOrder(bobKey, ob);

        // Relayer 1 settles first → success
        vm.prank(relayer1);
        settlement.settle(sigA, sigB, oa, ob, 0);

        // Relayer 2 tries same orders → nonce consumed
        vm.prank(relayer2);
        vm.expectRevert(ScatterSettlement.NonceConsumed.selector);
        settlement.settle(sigA, sigB, oa, ob, 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST 4: Partial claim + refund flow
    // ═══════════════════════════════════════════════════════════════

    function test_e2e_partial_claim_refund() public {
        vm.prank(alice); settlement.deposit(address(weth), 10 ether);
        vm.prank(bob);   settlement.deposit(address(usdc), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory ac = new ScatterSettlement.ClaimInfo[](3);
        ac[0] = ScatterSettlement.ClaimInfo(_claimHash(s1, recv1), 7000e18, 2 hours);
        ac[1] = ScatterSettlement.ClaimInfo(_claimHash(s2, recv2), 7000e18, 4 hours);
        ac[2] = ScatterSettlement.ClaimInfo(_claimHash(s3, recv3), 7000e18, 6 hours);
        ScatterSettlement.Order memory ao = ScatterSettlement.Order({
            maker: alice, sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 50, claims: ac
        });

        ScatterSettlement.ClaimInfo[] memory bc = new ScatterSettlement.ClaimInfo[](1);
        bc[0] = ScatterSettlement.ClaimInfo(_claimHash(s4, recv4), 10 ether, 3 hours);
        ScatterSettlement.Order memory bo = ScatterSettlement.Order({
            maker: bob, sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 50, claims: bc
        });

        {
            bytes memory sa = _signOrder(aliceKey, ao);
            bytes memory sb = _signOrder(bobKey, bo);
            vm.prank(relayer1);
            settlement.settle(sa, sb, ao, bo, 0);
        }

        uint256 t0 = block.timestamp;

        // recv1 claims
        vm.warp(t0 + 2 hours);
        vm.prank(recv1);
        settlement.claimRelease(s1);

        // recv2 and recv3 never claim → refund after expiry
        vm.warp(t0 + 4 hours + 7 days);
        vm.prank(alice);
        settlement.refundUnclaimed(_claimHash(s2, recv2));

        vm.warp(t0 + 6 hours + 7 days);
        vm.prank(alice);
        settlement.refundUnclaimed(_claimHash(s3, recv3));

        // Alice withdraws refunded USDC
        assertEq(settlement.deposits(alice, address(usdc)), 14_000e18);
        vm.prank(alice);
        settlement.withdraw(address(usdc), 14_000e18);

        // Conservation: 7000 claimed + 14000 refunded = 21000
        // Alice had 1M USDC initially, so check the refunded amount specifically
        assertEq(usdc.balanceOf(recv1), 7000e18, "recv1 claimed");
        assertEq(settlement.deposits(alice, address(usdc)), 0, "alice escrow empty after withdraw");
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST 5: Relayer lifecycle — register, update, exit, re-register
    // ═══════════════════════════════════════════════════════════════

    function test_e2e_relayer_lifecycle() public {
        address newRelayer = address(0xBB);
        vm.deal(newRelayer, 5 ether);

        // Register
        vm.prank(newRelayer);
        relayerRegistry.register{value: 0.5 ether}("http://new-relayer", 25);
        assertTrue(relayerRegistry.isActiveRelayer(newRelayer));

        // Update info
        vm.prank(newRelayer);
        relayerRegistry.updateInfo("http://updated-relayer", 15);

        // Add bond
        vm.prank(newRelayer);
        relayerRegistry.addBond{value: 0.3 ether}();

        // Request exit
        vm.prank(newRelayer);
        relayerRegistry.requestExit();
        assertFalse(relayerRegistry.isActiveRelayer(newRelayer));

        // Wait cooldown
        vm.warp(block.timestamp + 7 days);

        // Execute exit
        uint256 balBefore = newRelayer.balance;
        vm.prank(newRelayer);
        relayerRegistry.executeExit();
        assertEq(newRelayer.balance, balBefore + 0.8 ether); // 0.5 + 0.3

        // Re-register
        vm.prank(newRelayer);
        relayerRegistry.register{value: 0.2 ether}("http://re-registered", 10);
        assertTrue(relayerRegistry.isActiveRelayer(newRelayer));

        // Verify no duplicate in list
        assertEq(relayerRegistry.getRelayerCount(), 3); // relayer1, relayer2, newRelayer
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST 6: Front-running resistance — wrong address can't claim
    // ═══════════════════════════════════════════════════════════════

    function test_e2e_frontRunning_resistance() public {
        vm.prank(alice); settlement.deposit(address(weth), 5 ether);
        vm.prank(bob);   settlement.deposit(address(usdc), 10_500e18);

        ScatterSettlement.ClaimInfo[] memory ac = new ScatterSettlement.ClaimInfo[](1);
        ac[0] = ScatterSettlement.ClaimInfo(_claimHash(s1, recv1), 10_500e18, 1 hours);
        ScatterSettlement.Order memory ao = ScatterSettlement.Order({
            maker: alice, sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 5 ether, buyAmount: 10_500e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 77, claims: ac
        });

        ScatterSettlement.ClaimInfo[] memory bc = new ScatterSettlement.ClaimInfo[](1);
        bc[0] = ScatterSettlement.ClaimInfo(_claimHash(s2, recv2), 5 ether, 1 hours);
        ScatterSettlement.Order memory bo = ScatterSettlement.Order({
            maker: bob, sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 10_500e18, buyAmount: 5 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 77, claims: bc
        });

        {
            bytes memory sa = _signOrder(aliceKey, ao);
            bytes memory sb = _signOrder(bobKey, bo);
            vm.prank(relayer1);
            settlement.settle(sa, sb, ao, bo, 0);
        }

        vm.warp(block.timestamp + 1 hours);

        // Attacker sees secret in mempool, tries to claim from wrong address
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(ScatterSettlement.ScheduleNotFound.selector);
        settlement.claimRelease(s1);

        // Real recipient can claim
        vm.prank(recv1);
        settlement.claimRelease(s1);
        assertEq(usdc.balanceOf(recv1), 10_500e18);
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST 7: 3-token concurrent trades (WETH↔USDC + USDC↔DAI)
    // ═══════════════════════════════════════════════════════════════

    function test_e2e_three_token_trades() public {
        // Two independent trades across 3 tokens, settled by different relayers
        vm.prank(alice);   settlement.deposit(address(weth), 5 ether);
        vm.prank(bob);     settlement.deposit(address(usdc), 10_500e18);
        vm.prank(charlie); settlement.deposit(address(usdc), 10_500e18); // for counter
        vm.prank(diana);   settlement.deposit(address(dai), 10_500e18);

        // Trade 1: Alice sells WETH, Bob buys WETH (pays USDC)
        ScatterSettlement.ClaimInfo[] memory c1 = new ScatterSettlement.ClaimInfo[](1);
        c1[0] = ScatterSettlement.ClaimInfo(_claimHash(s1, recv1), 10_500e18, 2 hours);
        ScatterSettlement.Order memory o1 = ScatterSettlement.Order({
            maker: alice, sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 5 ether, buyAmount: 10_500e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 200, claims: c1
        });

        ScatterSettlement.ClaimInfo[] memory c2 = new ScatterSettlement.ClaimInfo[](1);
        c2[0] = ScatterSettlement.ClaimInfo(_claimHash(s2, recv2), 5 ether, 3 hours);
        ScatterSettlement.Order memory o2 = ScatterSettlement.Order({
            maker: bob, sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 10_500e18, buyAmount: 5 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 200, claims: c2
        });

        // Trade 2: Charlie sells USDC, Diana buys USDC (pays DAI)
        ScatterSettlement.ClaimInfo[] memory c3 = new ScatterSettlement.ClaimInfo[](1);
        c3[0] = ScatterSettlement.ClaimInfo(_claimHash(s3, recv3), 10_500e18, 4 hours);
        ScatterSettlement.Order memory o3 = ScatterSettlement.Order({
            maker: charlie, sellToken: address(usdc), buyToken: address(dai),
            sellAmount: 10_500e18, buyAmount: 10_500e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 200, claims: c3
        });

        ScatterSettlement.ClaimInfo[] memory c4 = new ScatterSettlement.ClaimInfo[](1);
        c4[0] = ScatterSettlement.ClaimInfo(_claimHash(s4, recv4), 10_500e18, 5 hours);
        ScatterSettlement.Order memory o4 = ScatterSettlement.Order({
            maker: diana, sellToken: address(dai), buyToken: address(usdc),
            sellAmount: 10_500e18, buyAmount: 10_500e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 200, claims: c4
        });

        {
            bytes memory sa = _signOrder(aliceKey, o1);
            bytes memory sb = _signOrder(bobKey, o2);
            bytes memory sc = _signOrder(charlieKey, o3);
            bytes memory sd = _signOrder(dianaKey, o4);
            vm.prank(relayer1);
            settlement.settle(sa, sb, o1, o2, 0);
            vm.prank(relayer2);
            settlement.settle(sc, sd, o3, o4, 0);
        }

        // All 4 claims
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 2 hours); vm.prank(recv1); settlement.claimRelease(s1);
        vm.warp(t0 + 3 hours); vm.prank(recv2); settlement.claimRelease(s2);
        vm.warp(t0 + 4 hours); vm.prank(recv3); settlement.claimRelease(s3);
        vm.warp(t0 + 5 hours); vm.prank(recv4); settlement.claimRelease(s4);

        assertEq(usdc.balanceOf(recv1), 10_500e18);
        assertEq(weth.balanceOf(recv2), 5 ether);
        assertEq(dai.balanceOf(recv3), 10_500e18);
        assertEq(usdc.balanceOf(recv4), 10_500e18);
    }
}
