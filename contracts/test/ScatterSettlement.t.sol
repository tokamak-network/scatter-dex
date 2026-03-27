// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ─── Mock Contracts ──────────────────────────────────────────────
contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockIdentityRegistry is IIdentityRegistry {
    mapping(address => bool) public verified;

    function setVerified(address user, bool status) external {
        verified[user] = status;
    }

    function isVerified(address user) external view override returns (bool) {
        return verified[user];
    }
}

// ─── Test Contract ───────────────────────────────────────────────
contract ScatterSettlementTest is Test {
    ScatterSettlement public settlement;
    IdentityGate public gate;
    MockIdentityRegistry public registry;
    MockToken public tokenA;
    MockToken public tokenB;

    uint256 makerKey = 0x1;
    uint256 takerKey = 0x2;
    address maker = vm.addr(makerKey);
    address taker = vm.addr(takerKey);

    address recipientC = address(0xC);
    address recipientD = address(0xD);
    address recipientE = address(0xE);
    address recipientF = address(0xF);

    bytes32 secret1 = keccak256("secret1");
    bytes32 secret2 = keccak256("secret2");
    bytes32 secret3 = keccak256("secret3");
    bytes32 secret4 = keccak256("secret4");

    function setUp() public {
        registry = new MockIdentityRegistry();
        gate = new IdentityGate(address(registry));
        settlement = new ScatterSettlement(address(gate));

        tokenA = new MockToken("Token A", "TKA");
        tokenB = new MockToken("Token B", "TKB");

        registry.setVerified(maker, true);
        registry.setVerified(taker, true);

        tokenA.mint(maker, 100 ether);
        tokenB.mint(taker, 210_000e18);

        vm.prank(maker);
        tokenA.approve(address(settlement), type(uint256).max);
        vm.prank(taker);
        tokenB.approve(address(settlement), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _claimHash(bytes32 secret, address recipient) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(secret, recipient));
    }

    function _signOrder(uint256 privateKey, ScatterSettlement.Order memory order) internal view returns (bytes memory) {
        bytes32 digest = _hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _hashOrder(ScatterSettlement.Order memory order) internal view returns (bytes32) {
        bytes32[] memory claimHashes = new bytes32[](order.claims.length);
        for (uint256 i = 0; i < order.claims.length; i++) {
            claimHashes[i] = keccak256(
                abi.encode(
                    settlement.CLAIM_INFO_TYPEHASH(),
                    order.claims[i].claimHash,
                    order.claims[i].amount,
                    order.claims[i].releaseDelay
                )
            );
        }

        bytes32 structHash = keccak256(
            abi.encode(
                settlement.ORDER_TYPEHASH(),
                order.maker,
                order.sellToken,
                order.buyToken,
                order.sellAmount,
                order.buyAmount,
                order.maxFee,
                order.expiry,
                order.nonce,
                keccak256(abi.encodePacked(claimHashes))
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScatterSettlement"),
                keccak256("1"),
                block.chainid,
                address(settlement)
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _createBasicOrders()
        internal
        view
        returns (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder)
    {
        ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](3);
        makerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 7000e18,
            releaseDelay: 3 hours
        });
        makerClaims[1] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret2, recipientD),
            amount: 8000e18,
            releaseDelay: 6 hours
        });
        makerClaims[2] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret3, recipientE),
            amount: 6000e18,
            releaseDelay: 9 hours
        });

        makerOrder = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 10 ether,
            buyAmount: 21_000e18,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: makerClaims
        });

        ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
        takerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret4, recipientF),
            amount: 10 ether,
            releaseDelay: 4 hours
        });

        takerOrder = ScatterSettlement.Order({
            maker: taker,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 21_000e18,
            buyAmount: 10 ether,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: takerClaims
        });
    }

    function _depositAndSettle()
        internal
        returns (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder)
    {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        (makerOrder, takerOrder) = _createBasicOrders();

        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
    }

    // ─── Tests: Deposit & Withdraw ───────────────────────────────

    function test_deposit() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        assertEq(settlement.deposits(maker, address(tokenA)), 10 ether);
        assertEq(tokenA.balanceOf(address(settlement)), 10 ether);
    }

    function test_deposit_unverified_reverts() public {
        address unverified = address(0x999);
        tokenA.mint(unverified, 10 ether);
        vm.startPrank(unverified);
        tokenA.approve(address(settlement), 10 ether);
        vm.expectRevert(ScatterSettlement.NotVerified.selector);
        settlement.deposit(address(tokenA), 10 ether);
        vm.stopPrank();
    }

    function test_deposit_zero_reverts() public {
        vm.prank(maker);
        vm.expectRevert(ScatterSettlement.ZeroAmount.selector);
        settlement.deposit(address(tokenA), 0);
    }

    function test_withdraw() public {
        vm.startPrank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        settlement.withdraw(address(tokenA), 4 ether);
        vm.stopPrank();

        assertEq(settlement.deposits(maker, address(tokenA)), 6 ether);
        assertEq(tokenA.balanceOf(maker), 94 ether);
    }

    function test_withdraw_insufficient_reverts() public {
        vm.startPrank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.expectRevert(ScatterSettlement.InsufficientBalance.selector);
        settlement.withdraw(address(tokenA), 11 ether);
        vm.stopPrank();
    }

    // ─── Tests: Settle ───────────────────────────────────────────

    function test_settle_basic() public {
        (ScatterSettlement.Order memory makerOrder,) = _depositAndSettle();

        assertEq(settlement.deposits(maker, address(tokenA)), 0);
        assertEq(settlement.deposits(taker, address(tokenB)), 0);
        assertEq(settlement.scheduleCount(), 4);

        // Verify maker's first claim schedule
        (bytes32 ch, address tok, uint48 rt, bool claimed, address dep, uint96 amt) = settlement.schedules(0);
        assertEq(ch, makerOrder.claims[0].claimHash);
        assertEq(tok, address(tokenB));
        assertEq(amt, uint96(7000e18));
        assertEq(rt, uint48(block.timestamp + 3 hours));
        assertFalse(claimed);
        assertEq(dep, maker);
    }

    function test_settle_nonce_replay_reverts() public {
        _depositAndSettle();

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.expectRevert(ScatterSettlement.NonceConsumed.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
    }

    function test_settle_expired_order_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(ScatterSettlement.OrderExpired.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
    }

    function test_settle_insufficient_escrow_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.expectRevert(ScatterSettlement.InsufficientEscrow.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
    }

    function test_settle_invalid_signature_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory badSig = _signOrder(takerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.expectRevert(ScatterSettlement.InvalidSignature.selector);
        settlement.settle(badSig, takerSig, makerOrder, takerOrder, 0);
    }

    // ─── Tests: Fee ──────────────────────────────────────────────

    function test_settle_with_fee() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](1);
        // 21000 * 30/10000 = 63 fee, distributable = 20937
        makerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 20_937e18,
            releaseDelay: 3 hours
        });

        ScatterSettlement.Order memory makerOrder = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 10 ether,
            buyAmount: 21_000e18,
            maxFee: 30,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: makerClaims
        });

        ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
        // 10 ETH * 30/10000 = 0.03 ETH fee, distributable = 9.97
        takerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret4, recipientF),
            amount: 9.97 ether,
            releaseDelay: 4 hours
        });

        ScatterSettlement.Order memory takerOrder = ScatterSettlement.Order({
            maker: taker,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 21_000e18,
            buyAmount: 10 ether,
            maxFee: 30,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: takerClaims
        });

        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        address relayer = address(0xABCD);
        vm.prank(relayer);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 30);

        assertEq(tokenA.balanceOf(relayer), 0.03 ether);
        assertEq(tokenB.balanceOf(relayer), 63e18);
    }

    function test_settle_fee_exceeds_max_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.expectRevert(ScatterSettlement.FeeExceedsMax.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 30);
    }

    // ─── Tests: Claim ────────────────────────────────────────────

    function test_claim_basic() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours);

        vm.prank(recipientC);
        settlement.claimRelease(0, secret1);

        assertEq(tokenB.balanceOf(recipientC), 7000e18);

        (,,,bool claimed,,) = settlement.schedules(0);
        assertTrue(claimed);
    }

    function test_claim_all_recipients() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(0, secret1);

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientD);
        settlement.claimRelease(1, secret2);

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientE);
        settlement.claimRelease(2, secret3);

        vm.prank(recipientF);
        settlement.claimRelease(3, secret4);

        assertEq(tokenB.balanceOf(recipientC), 7000e18);
        assertEq(tokenB.balanceOf(recipientD), 8000e18);
        assertEq(tokenB.balanceOf(recipientE), 6000e18);
        assertEq(tokenA.balanceOf(recipientF), 10 ether);
    }

    function test_claim_before_release_reverts() public {
        _depositAndSettle();

        vm.prank(recipientC);
        vm.expectRevert(ScatterSettlement.NotYetReleasable.selector);
        settlement.claimRelease(0, secret1);
    }

    function test_claim_wrong_secret_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours);

        vm.prank(recipientC);
        vm.expectRevert(ScatterSettlement.InvalidSecretOrAddress.selector);
        settlement.claimRelease(0, keccak256("wrong_secret"));
    }

    function test_claim_wrong_address_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours);

        vm.prank(address(0xA77AC8E4));
        vm.expectRevert(ScatterSettlement.InvalidSecretOrAddress.selector);
        settlement.claimRelease(0, secret1);
    }

    function test_claim_double_claim_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours);

        vm.prank(recipientC);
        settlement.claimRelease(0, secret1);

        vm.prank(recipientC);
        vm.expectRevert(ScatterSettlement.AlreadyClaimed.selector);
        settlement.claimRelease(0, secret1);
    }

    // ─── Tests: Refund ───────────────────────────────────────────

    function test_refund_after_expiry() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours + 7 days);

        vm.prank(maker);
        settlement.refundUnclaimed(0);

        assertEq(settlement.deposits(maker, address(tokenB)), 7000e18);

        vm.prank(maker);
        settlement.withdraw(address(tokenB), 7000e18);
        assertEq(tokenB.balanceOf(maker), 7000e18);
    }

    function test_refund_before_expiry_reverts() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours + 6 days);

        vm.prank(maker);
        vm.expectRevert(ScatterSettlement.ClaimWindowNotExpired.selector);
        settlement.refundUnclaimed(0);
    }

    function test_refund_not_depositor_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours + 7 days);

        vm.prank(address(0x999));
        vm.expectRevert(ScatterSettlement.NotDepositor.selector);
        settlement.refundUnclaimed(0);
    }

    function test_refund_already_claimed_reverts() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(0, secret1);

        vm.warp(block.timestamp + 7 days);
        vm.prank(maker);
        vm.expectRevert(ScatterSettlement.AlreadyClaimed.selector);
        settlement.refundUnclaimed(0);
    }

    // ─── Tests: Partial claim + refund ───────────────────────────

    function test_partial_claim_and_refund() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(0, secret1);

        vm.warp(block.timestamp + 7 days + 6 hours);

        vm.prank(maker);
        settlement.refundUnclaimed(1);

        assertEq(tokenB.balanceOf(recipientC), 7000e18);
        assertEq(settlement.deposits(maker, address(tokenB)), 8000e18);
    }

    // ─── Tests: Price Compatibility ──────────────────────────────

    function test_settle_price_incompatible_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](1);
        makerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 21_000e18,
            releaseDelay: 3 hours
        });

        ScatterSettlement.Order memory makerOrder = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 10 ether,
            buyAmount: 21_000e18,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: makerClaims
        });

        ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
        takerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret4, recipientF),
            amount: 10 ether,
            releaseDelay: 4 hours
        });

        ScatterSettlement.Order memory takerOrder = ScatterSettlement.Order({
            maker: taker,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 15_000e18,
            buyAmount: 10 ether,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: takerClaims
        });

        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.expectRevert(ScatterSettlement.ClaimsSumMismatch.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
    }
}
