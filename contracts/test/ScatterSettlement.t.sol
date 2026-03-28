// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
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

    function verifiedUntil(address) external pure override returns (uint64) {
        return type(uint64).max;
    }

    function paused() external pure override returns (bool) {
        return false;
    }
}

// ─── Test Contract ───────────────────────────────────────────────
contract ScatterSettlementTest is Test {
    ScatterSettlement public settlement;
    IdentityGate public gate;
    RelayerRegistry public relayerRegistry;
    MockIdentityRegistry public registry;
    MockToken public tokenA;
    MockToken public tokenB;

    address treasury = address(0x7777);

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
        relayerRegistry = new RelayerRegistry(treasury);
        settlement = new ScatterSettlement(address(gate), address(relayerRegistry), 0);

        tokenA = new MockToken("Token A", "TKA");
        tokenB = new MockToken("Token B", "TKB");

        settlement.setTokenWhitelist(address(tokenA), true);
        settlement.setTokenWhitelist(address(tokenB), true);

        registry.setVerified(maker, true);
        registry.setVerified(taker, true);

        // Register default relayer (test contract itself acts as relayer)
        relayerRegistry.register{value: 0.1 ether}("http://localhost", 30);

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

        // Verify maker's first claim schedule
        bytes32 ch = _claimHash(secret1, recipientC);
        (address tok, uint48 rt, bool claimed, address dep, uint96 amt) = settlement.schedules(ch);
        assertEq(tok, address(tokenB));
        assertEq(amt, uint96(7000e18));
        assertEq(rt, uint48(block.timestamp + 3 hours));
        assertFalse(claimed);
        assertEq(dep, maker);

        // Verify nonces are marked as Settled (1), not just consumed
        // NonceState: 0=Unused, 1=Settled, 2=Cancelled
        assertEq(uint8(settlement.nonces(maker, makerOrder.nonce)), 1, "maker nonce should be Settled");
        assertEq(uint8(settlement.nonces(taker, 1)), 1, "taker nonce should be Settled");
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

        address feeRelayer = address(0xABCD);
        vm.deal(feeRelayer, 1 ether);
        vm.prank(feeRelayer);
        relayerRegistry.register{value: 0.1 ether}("http://fee-relayer", 30);

        vm.prank(feeRelayer);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 30);

        // No protocol fee (protocolFeeBps = 0 in setUp)
        assertEq(tokenA.balanceOf(feeRelayer), 0.03 ether);
        assertEq(tokenB.balanceOf(feeRelayer), 63e18);
    }

    function test_settle_with_protocol_fee() public {
        // Set protocol fee to 3000 bps (30% of total fee goes to treasury)
        settlement.setProtocolFee(3000);

        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](1);
        makerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 20_937e18,
            releaseDelay: 3 hours
        });
        ScatterSettlement.Order memory makerOrder = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 30,
            expiry: block.timestamp + 1 days, nonce: 1, claims: makerClaims
        });

        ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
        takerClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret4, recipientF),
            amount: 9.97 ether,
            releaseDelay: 4 hours
        });
        ScatterSettlement.Order memory takerOrder = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 30,
            expiry: block.timestamp + 1 days, nonce: 1, claims: takerClaims
        });

        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        // settle from test contract (registered relayer)
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 30);

        // ETH fee: 0.03 ETH total. Protocol 30% = 0.009, Relayer 70% = 0.021
        uint256 ethTotalFee = 0.03 ether;
        uint256 ethProtocol = (ethTotalFee * 3000) / 10000; // 0.009
        uint256 ethRelayer = ethTotalFee - ethProtocol; // 0.021

        assertEq(tokenA.balanceOf(treasury), ethProtocol, "treasury ETH fee");
        assertEq(tokenA.balanceOf(address(this)), ethRelayer, "relayer ETH fee");

        // USDC fee: 63 USDC total. Protocol 30% = 18.9, Relayer 70% = 44.1
        uint256 usdcTotalFee = 63e18;
        uint256 usdcProtocol = (usdcTotalFee * 3000) / 10000;
        uint256 usdcRelayer = usdcTotalFee - usdcProtocol;

        assertEq(tokenB.balanceOf(treasury), usdcProtocol, "treasury USDC fee");
        assertEq(tokenB.balanceOf(address(this)), usdcRelayer, "relayer USDC fee");
    }

    function test_constructor_fee_too_high_reverts() public {
        vm.expectRevert(ScatterSettlement.FeeTooHigh.selector);
        new ScatterSettlement(address(gate), address(relayerRegistry), 10001);
    }

    function test_setProtocolFee_too_high_reverts() public {
        vm.expectRevert(ScatterSettlement.FeeTooHigh.selector);
        settlement.setProtocolFee(10001);
    }

    function test_constructor_zero_address_reverts() public {
        vm.expectRevert(ScatterSettlement.ZeroAddress.selector);
        new ScatterSettlement(address(0), address(relayerRegistry), 0);
    }

    function test_pause_blocks_settle() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        settlement.setPaused(true);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.expectRevert(ScatterSettlement.ContractPaused.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
    }

    function test_pause_blocks_claim() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours);

        settlement.setPaused(true);

        vm.prank(recipientC);
        vm.expectRevert(ScatterSettlement.ContractPaused.selector);
        settlement.claimRelease(secret1);
    }

    function test_transferOwnership_two_step() public {
        address newOwner = address(0xBBBB);
        settlement.transferOwnership(newOwner);
        // Owner not changed yet
        assertEq(settlement.owner(), address(this));
        assertEq(settlement.pendingOwner(), newOwner);

        // New owner accepts
        vm.prank(newOwner);
        settlement.acceptOwnership();
        assertEq(settlement.owner(), newOwner);
        assertEq(settlement.pendingOwner(), address(0));
    }

    function test_transferOwnership_not_owner_reverts() public {
        vm.prank(maker);
        vm.expectRevert(ScatterSettlement.NotOwner.selector);
        settlement.transferOwnership(maker);
    }

    function test_acceptOwnership_not_pending_reverts() public {
        settlement.transferOwnership(address(0xBBBB));
        vm.prank(maker);
        vm.expectRevert(ScatterSettlement.NotPendingOwner.selector);
        settlement.acceptOwnership();
    }

    function test_setProtocolFee_5000_boundary() public {
        settlement.setProtocolFee(5000); // should pass (50%)
        assertEq(settlement.protocolFeeBps(), 5000);
    }

    function test_setProtocolFee_5001_reverts() public {
        vm.expectRevert(ScatterSettlement.FeeTooHigh.selector);
        settlement.setProtocolFee(5001);
    }

    function test_settle_unregistered_relayer_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        // Call from unregistered address
        vm.prank(address(0xDEAD));
        vm.expectRevert(ScatterSettlement.NotActiveRelayer.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
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
        settlement.claimRelease(secret1);

        assertEq(tokenB.balanceOf(recipientC), 7000e18);

        (,,bool claimed,,) = settlement.schedules(_claimHash(secret1, recipientC));
        assertTrue(claimed);
    }

    function test_claim_all_recipients() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(secret1);

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientD);
        settlement.claimRelease(secret2);

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientE);
        settlement.claimRelease(secret3);

        vm.prank(recipientF);
        settlement.claimRelease(secret4);

        assertEq(tokenB.balanceOf(recipientC), 7000e18);
        assertEq(tokenB.balanceOf(recipientD), 8000e18);
        assertEq(tokenB.balanceOf(recipientE), 6000e18);
        assertEq(tokenA.balanceOf(recipientF), 10 ether);
    }

    function test_claim_before_release_reverts() public {
        _depositAndSettle();

        vm.prank(recipientC);
        vm.expectRevert(ScatterSettlement.NotYetReleasable.selector);
        settlement.claimRelease(secret1);
    }

    function test_claim_wrong_secret_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours);

        vm.prank(recipientC);
        vm.expectRevert(ScatterSettlement.ScheduleNotFound.selector);
        settlement.claimRelease(keccak256("wrong_secret"));
    }

    function test_claim_wrong_address_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours);

        vm.prank(address(0xA77AC8E4));
        vm.expectRevert(ScatterSettlement.ScheduleNotFound.selector);
        settlement.claimRelease(secret1);
    }

    function test_claim_double_claim_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours);

        vm.prank(recipientC);
        settlement.claimRelease(secret1);

        vm.prank(recipientC);
        vm.expectRevert(ScatterSettlement.AlreadyClaimed.selector);
        settlement.claimRelease(secret1);
    }

    // ─── Tests: Refund ───────────────────────────────────────────

    function test_refund_after_expiry() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours + 7 days);

        vm.prank(maker);
        settlement.refundUnclaimed(_claimHash(secret1, recipientC));

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
        settlement.refundUnclaimed(_claimHash(secret1, recipientC));
    }

    function test_refund_not_depositor_reverts() public {
        _depositAndSettle();
        vm.warp(block.timestamp + 3 hours + 7 days);

        vm.prank(address(0x999));
        vm.expectRevert(ScatterSettlement.NotDepositor.selector);
        settlement.refundUnclaimed(_claimHash(secret1, recipientC));
    }

    function test_refund_already_claimed_reverts() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(secret1);

        vm.warp(block.timestamp + 7 days);
        vm.prank(maker);
        vm.expectRevert(ScatterSettlement.AlreadyClaimed.selector);
        settlement.refundUnclaimed(_claimHash(secret1, recipientC));
    }

    // ─── Tests: Partial claim + refund ───────────────────────────

    function test_partial_claim_and_refund() public {
        _depositAndSettle();

        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(secret1);

        vm.warp(block.timestamp + 7 days + 6 hours);

        vm.prank(maker);
        settlement.refundUnclaimed(_claimHash(secret2, recipientD));

        assertEq(tokenB.balanceOf(recipientC), 7000e18);
        assertEq(settlement.deposits(maker, address(tokenB)), 8000e18);
    }

    // ─── Tests: Cancel Order ───────────────────────────────────────

    function test_cancel_order() public {
        settlement.cancelOrder(42);
        // NonceState: 0=Unused, 1=Settled, 2=Cancelled
        assertEq(uint8(settlement.nonces(address(this), 42)), 2);
    }

    function test_cancel_already_consumed_reverts() public {
        settlement.cancelOrder(42);
        vm.expectRevert(ScatterSettlement.NonceConsumed.selector);
        settlement.cancelOrder(42);
    }

    function test_cancel_prevents_settle() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        // Maker cancels nonce 1 before settle
        vm.prank(maker);
        settlement.cancelOrder(1);

        (ScatterSettlement.Order memory makerOrder, ScatterSettlement.Order memory takerOrder) = _createBasicOrders();
        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        vm.expectRevert(ScatterSettlement.NonceConsumed.selector);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0);
    }

    // ─── Tests: Self-Trade ───────────────────────────────────────

    function test_settle_self_trade_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        tokenB.mint(maker, 21_000e18);
        vm.prank(maker);
        tokenB.approve(address(settlement), type(uint256).max);
        vm.prank(maker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory claims1 = new ScatterSettlement.ClaimInfo[](1);
        claims1[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 21_000e18,
            releaseDelay: 3 hours
        });

        ScatterSettlement.Order memory order1 = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 10 ether,
            buyAmount: 21_000e18,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: claims1
        });

        ScatterSettlement.ClaimInfo[] memory claims2 = new ScatterSettlement.ClaimInfo[](1);
        claims2[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret2, recipientD),
            amount: 10 ether,
            releaseDelay: 4 hours
        });

        // Same maker for both orders
        ScatterSettlement.Order memory order2 = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 21_000e18,
            buyAmount: 10 ether,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 2,
            claims: claims2
        });

        bytes memory sig1 = _signOrder(makerKey, order1);
        bytes memory sig2 = _signOrder(makerKey, order2);

        vm.expectRevert(ScatterSettlement.SelfTrade.selector);
        settlement.settle(sig1, sig2, order1, order2, 0);
    }

    // ─── Tests: Price Compatibility ──────────────────────────────

    function test_settle_release_delay_too_short_reverts() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(secret1, recipientC), 21_000e18, 30 minutes); // too short

        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 900, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(secret2, recipientD), 10 ether, 3 hours);

        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 900, claims: tc
        });

        bytes memory makerSig = _signOrder(makerKey, mo);
        bytes memory takerSig = _signOrder(takerKey, to_);
        vm.expectRevert(ScatterSettlement.ReleaseDelayTooShort.selector);
        settlement.settle(makerSig, takerSig, mo, to_, 0);
    }

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

    // ─── E2E: Full Scenario (Paper Section 3.4) ──────────────────

    function test_e2e_full_scenario() public {
        // === Setup: Alice sells 10 ETH @ 2100, Bob buys 10 ETH @ 2100 ===
        // Alice = maker, Bob = taker
        // Alice receives USDC split to 3 addresses over 3-9 hours
        // Bob receives ETH to 1 address after 4 hours
        // Relayer charges 0.3% fee

        address e2eRelayer = address(0xBEEF);
        vm.deal(e2eRelayer, 1 ether);
        vm.prank(e2eRelayer);
        relayerRegistry.register{value: 0.1 ether}("http://e2e-relayer", 30);

        // 1. Deposit
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        // 2. Create orders with fee
        uint256 usdcFee = (21_000e18 * 30) / 10000; // 63 USDC
        uint256 usdcDistributable = 21_000e18 - usdcFee; // 20937 USDC
        uint256 ethFee = (10 ether * 30) / 10000; // 0.03 ETH
        uint256 ethDistributable = 10 ether - ethFee; // 9.97 ETH

        ScatterSettlement.ClaimInfo[] memory aliceClaims = new ScatterSettlement.ClaimInfo[](3);
        aliceClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 7000e18,
            releaseDelay: 3 hours
        });
        aliceClaims[1] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret2, recipientD),
            amount: 8000e18,
            releaseDelay: 6 hours
        });
        aliceClaims[2] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret3, recipientE),
            amount: usdcDistributable - 7000e18 - 8000e18, // 5937 USDC
            releaseDelay: 9 hours
        });

        ScatterSettlement.Order memory aliceOrder = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 10 ether,
            buyAmount: 21_000e18,
            maxFee: 30,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: aliceClaims
        });

        ScatterSettlement.ClaimInfo[] memory bobClaims = new ScatterSettlement.ClaimInfo[](1);
        bobClaims[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret4, recipientF),
            amount: ethDistributable,
            releaseDelay: 4 hours
        });

        ScatterSettlement.Order memory bobOrder = ScatterSettlement.Order({
            maker: taker,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 21_000e18,
            buyAmount: 10 ether,
            maxFee: 30,
            expiry: block.timestamp + 1 days,
            nonce: 1,
            claims: bobClaims
        });

        // 3. Sign & settle
        bytes memory aliceSig = _signOrder(makerKey, aliceOrder);
        bytes memory bobSig = _signOrder(takerKey, bobOrder);

        vm.prank(e2eRelayer);
        settlement.settle(aliceSig, bobSig, aliceOrder, bobOrder, 30);

        // 4. Verify post-settle state
        assertEq(settlement.deposits(maker, address(tokenA)), 0, "alice escrow should be 0");
        assertEq(settlement.deposits(taker, address(tokenB)), 0, "bob escrow should be 0");
        assertEq(tokenA.balanceOf(e2eRelayer), ethFee, "relayer ETH fee");
        assertEq(tokenB.balanceOf(e2eRelayer), usdcFee, "relayer USDC fee");
        // 5. Time-delayed claims
        uint256 settleTime = block.timestamp;

        // t+3h: recipientC claims 7000 USDC
        vm.warp(settleTime + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(secret1);
        assertEq(tokenB.balanceOf(recipientC), 7000e18);

        // t+4h: recipientF claims 9.97 ETH
        vm.warp(settleTime + 4 hours);
        vm.prank(recipientF);
        settlement.claimRelease(secret4);
        assertEq(tokenA.balanceOf(recipientF), ethDistributable);

        // t+6h: recipientD claims 8000 USDC
        vm.warp(settleTime + 6 hours);
        vm.prank(recipientD);
        settlement.claimRelease(secret2);
        assertEq(tokenB.balanceOf(recipientD), 8000e18);

        // t+9h: recipientE claims remaining USDC
        vm.warp(settleTime + 9 hours);
        vm.prank(recipientE);
        settlement.claimRelease(secret3);
        assertEq(tokenB.balanceOf(recipientE), usdcDistributable - 7000e18 - 8000e18);

        // 6. Verify all funds distributed correctly
        uint256 totalUsdcOut = tokenB.balanceOf(recipientC) + tokenB.balanceOf(recipientD)
            + tokenB.balanceOf(recipientE) + tokenB.balanceOf(e2eRelayer);
        assertEq(totalUsdcOut, 21_000e18, "total USDC conservation");

        uint256 totalEthOut = tokenA.balanceOf(recipientF) + tokenA.balanceOf(e2eRelayer);
        assertEq(totalEthOut, 10 ether, "total ETH conservation");
    }

    // ─── E2E: Multiple Concurrent Trades ─────────────────────────

    function test_e2e_concurrent_trades() public {
        // Two independent trades happening simultaneously
        // Trade 1: maker sells 5 TKA for 10500 TKB
        // Trade 2: maker sells 5 TKA for 10500 TKB (different nonce)

        uint256 trader2Key = 0x3;
        address trader2 = vm.addr(trader2Key);
        registry.setVerified(trader2, true);
        tokenB.mint(trader2, 10_500e18);
        vm.prank(trader2);
        tokenB.approve(address(settlement), type(uint256).max);

        // Deposits
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 10_500e18);
        vm.prank(trader2);
        settlement.deposit(address(tokenB), 10_500e18);

        // Trade 1: maker(5 ETH) <-> taker(10500 USDC)
        ScatterSettlement.ClaimInfo[] memory claims1m = new ScatterSettlement.ClaimInfo[](1);
        claims1m[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 10_500e18,
            releaseDelay: 2 hours
        });
        ScatterSettlement.Order memory order1m = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 5 ether,
            buyAmount: 10_500e18,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 10,
            claims: claims1m
        });

        ScatterSettlement.ClaimInfo[] memory claims1t = new ScatterSettlement.ClaimInfo[](1);
        claims1t[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret2, recipientD),
            amount: 5 ether,
            releaseDelay: 3 hours
        });
        ScatterSettlement.Order memory order1t = ScatterSettlement.Order({
            maker: taker,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 10_500e18,
            buyAmount: 5 ether,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 10,
            claims: claims1t
        });

        // Trade 2: maker(5 ETH) <-> trader2(10500 USDC)
        ScatterSettlement.ClaimInfo[] memory claims2m = new ScatterSettlement.ClaimInfo[](1);
        claims2m[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret3, recipientE),
            amount: 10_500e18,
            releaseDelay: 5 hours
        });
        ScatterSettlement.Order memory order2m = ScatterSettlement.Order({
            maker: maker,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 5 ether,
            buyAmount: 10_500e18,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 11,
            claims: claims2m
        });

        ScatterSettlement.ClaimInfo[] memory claims2t = new ScatterSettlement.ClaimInfo[](1);
        claims2t[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret4, recipientF),
            amount: 5 ether,
            releaseDelay: 6 hours
        });
        ScatterSettlement.Order memory order2t = ScatterSettlement.Order({
            maker: trader2,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 10_500e18,
            buyAmount: 5 ether,
            maxFee: 0,
            expiry: block.timestamp + 1 days,
            nonce: 10,
            claims: claims2t
        });

        // Settle both trades
        settlement.settle(
            _signOrder(makerKey, order1m),
            _signOrder(takerKey, order1t),
            order1m, order1t, 0
        );
        settlement.settle(
            _signOrder(makerKey, order2m),
            _signOrder(trader2Key, order2t),
            order2m, order2t, 0
        );

        // Verify escrows depleted
        assertEq(settlement.deposits(maker, address(tokenA)), 0);

        // Claims at different times — all mixed in the contract
        uint256 settleTime = block.timestamp;

        vm.warp(settleTime + 2 hours);
        vm.prank(recipientC);
        settlement.claimRelease(secret1);

        vm.warp(settleTime + 3 hours);
        vm.prank(recipientD);
        settlement.claimRelease(secret2);

        vm.warp(settleTime + 5 hours);
        vm.prank(recipientE);
        settlement.claimRelease(secret3);

        vm.warp(settleTime + 6 hours);
        vm.prank(recipientF);
        settlement.claimRelease(secret4);

        // All recipients got their tokens
        assertEq(tokenB.balanceOf(recipientC), 10_500e18);
        assertEq(tokenA.balanceOf(recipientD), 5 ether);
        assertEq(tokenB.balanceOf(recipientE), 10_500e18);
        assertEq(tokenA.balanceOf(recipientF), 5 ether);
    }

    // ─── E2E: Refund Flow ────────────────────────────────────────

    function test_e2e_partial_claim_then_refund_then_withdraw() public {
        _depositAndSettle();

        uint256 settleTime = block.timestamp;

        // recipientC claims at t+3h
        vm.warp(settleTime + 3 hours);
        vm.prank(recipientC);
        settlement.claimRelease(secret1);

        // recipientD and recipientE never claim
        // Wait for refund window on schedule 1 (6h delay + 7d)
        vm.warp(settleTime + 6 hours + 7 days);
        vm.prank(maker);
        settlement.refundUnclaimed(_claimHash(secret2, recipientD)); // 8000 USDC back to escrow

        // Wait for refund window on schedule 2 (9h delay + 7d)
        vm.warp(settleTime + 9 hours + 7 days);
        vm.prank(maker);
        settlement.refundUnclaimed(_claimHash(secret3, recipientE)); // 6000 USDC back to escrow

        // Maker withdraws refunded funds
        assertEq(settlement.deposits(maker, address(tokenB)), 14_000e18);
        vm.prank(maker);
        settlement.withdraw(address(tokenB), 14_000e18);
        assertEq(tokenB.balanceOf(maker), 14_000e18);

        // recipientC got their share
        assertEq(tokenB.balanceOf(recipientC), 7000e18);

        // Total: 7000 (claimed) + 14000 (refunded) = 21000 (original)
        assertEq(
            tokenB.balanceOf(recipientC) + tokenB.balanceOf(maker),
            21_000e18,
            "fund conservation"
        );
    }

    // ─── Tests: Fee enforcement & registry caps ──────────────────

    function test_settle_fee_exceeds_relayer_registered_reverts() public {
        // Relayer registered with fee=30 bps in setUp
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        // Create orders with maxFee=100 (allows up to 100 bps)
        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret1, recipientC),
            amount: 20_790e18, // 21000 - 1% fee = 20790
            releaseDelay: 3 hours
        });
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 100,
            expiry: block.timestamp + 1 days, nonce: 1, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo({
            claimHash: _claimHash(secret4, recipientF),
            amount: 9.9 ether, // 10 - 1% = 9.9
            releaseDelay: 4 hours
        });
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 100,
            expiry: block.timestamp + 1 days, nonce: 1, claims: tc
        });

        bytes memory ms = _signOrder(makerKey, mo);
        bytes memory ts = _signOrder(takerKey, to_);

        // actualFee=50 > registeredFee=30 → should revert
        vm.expectRevert(ScatterSettlement.FeeExceedsRelayerRegistered.selector);
        settlement.settle(ms, ts, mo, to_, 50);
    }

    // ─── Tests: Gasless Claim ──────────────────────────────────────

    function _signGaslessClaim(uint256 privateKey, bytes32 secret, address recipient, address relayer, uint256 relayerTip, uint256 deadline) internal view returns (bytes memory) {
        uint256 nonce = settlement.gaslessNonces(recipient);
        bytes32 structHash = keccak256(
            abi.encode(settlement.GASLESS_CLAIM_TYPEHASH(), secret, recipient, relayer, relayerTip, deadline, nonce)
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_gasless_claim_basic() public {
        // Fresh setup with known private key recipient
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("gasless-secret");
        uint256 tip = 100e18; // 100 USDC tip to relayer

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 500, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("gasless-taker"), address(0xDDD)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 500, claims: tc
        });

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);

        vm.warp(block.timestamp + 3 hours);

        // Relayer (this test contract) claims on behalf of recv
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory recipientSig = _signGaslessClaim(recvKey, freshSecret, recv, address(this), tip, deadline);
        settlement.claimReleaseFor(freshSecret, recv, tip, deadline, recipientSig);

        assertEq(tokenB.balanceOf(recv), 21_000e18 - tip, "recipient receives amount minus tip");
        assertEq(tokenB.balanceOf(address(this)), tip, "relayer receives tip");
    }

    function test_gasless_claim_zero_tip() public {
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("zero-tip-secret");

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 501, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("zero-tip-taker"), address(0xEEE)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 501, claims: tc
        });

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);
        vm.warp(block.timestamp + 3 hours);

        // Zero tip — altruistic relayer
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signGaslessClaim(recvKey, freshSecret, recv, address(this), 0, deadline);
        settlement.claimReleaseFor(freshSecret, recv, 0, deadline, sig);

        assertEq(tokenB.balanceOf(recv), 21_000e18, "recipient gets full amount");
    }

    function test_gasless_claim_wrong_signer_reverts() public {
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("wrong-signer-secret");

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 502, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("wrong-taker"), address(0xFFF)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 502, claims: tc
        });

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);
        vm.warp(block.timestamp + 3 hours);

        // Attacker signs instead of recipient — wrong signer
        uint256 attackerKey = 0xBAD;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory badSig = _signGaslessClaim(attackerKey, freshSecret, recv, address(this), 100e18, deadline);
        vm.expectRevert(ScatterSettlement.InvalidSignature.selector);
        settlement.claimReleaseFor(freshSecret, recv, 100e18, deadline, badSig);
    }

    function test_gasless_claim_tip_exceeds_amount_reverts() public {
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("tip-too-high");

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 503, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("tip-taker"), address(0xAAA)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 503, claims: tc
        });

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);
        vm.warp(block.timestamp + 3 hours);

        // Tip > claim amount
        uint256 excessiveTip = 22_000e18;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signGaslessClaim(recvKey, freshSecret, recv, address(this), excessiveTip, deadline);
        vm.expectRevert(ScatterSettlement.TipExceedsAmount.selector);
        settlement.claimReleaseFor(freshSecret, recv, excessiveTip, deadline, sig);
    }

    function test_gasless_claim_expired_deadline_reverts() public {
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("expired-deadline");

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 504, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("expired-taker"), address(0xBBB)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 504, claims: tc
        });

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);
        vm.warp(block.timestamp + 3 hours);

        // Sign with deadline in the past
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signGaslessClaim(recvKey, freshSecret, recv, address(this), 100e18, deadline);
        vm.expectRevert(ScatterSettlement.SignatureExpired.selector);
        settlement.claimReleaseFor(freshSecret, recv, 100e18, deadline, sig);
    }

    function _signCancelGasless(uint256 privateKey, address recipient) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(settlement.CANCEL_GASLESS_CLAIM_TYPEHASH(), recipient, settlement.gaslessNonces(recipient))
        );
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScatterSettlement"), keccak256("1"),
                block.chainid, address(settlement)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_gasless_cancel_invalidates_signature() public {
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("cancel-test");

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 505, claims: mc
        });

        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("cancel-taker"), address(0xCCC)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 505, claims: tc
        });

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);
        vm.warp(block.timestamp + 3 hours);

        // 1. Recipient signs a gasless claim (nonce=0)
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory claimSig = _signGaslessClaim(recvKey, freshSecret, recv, address(this), 100e18, deadline);

        // 2. Recipient cancels — friend submits cancel signature
        bytes memory cancelSig = _signCancelGasless(recvKey, recv);
        settlement.cancelGaslessClaimFor(recv, cancelSig);
        assertEq(settlement.gaslessNonces(recv), 1);

        // 3. Old claim signature (nonce=0) is now invalid
        vm.expectRevert(ScatterSettlement.InvalidSignature.selector);
        settlement.claimReleaseFor(freshSecret, recv, 100e18, deadline, claimSig);
    }

    // ─── Tests: Coverage Boost ──────────────────────────────────────

    function test_gasless_claim_wrong_relayer_reverts() public {
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("wrong-relayer-secret");

        tokenA.mint(maker, 10 ether);
        tokenB.mint(taker, 21_000e18);
        vm.prank(maker); settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker); settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 600, claims: mc
        });
        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("wr-taker"), address(0xEEE)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 600, claims: tc
        });

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);
        vm.warp(block.timestamp + 4 hours);

        // Sign for address(this) as relayer, but submit from a different address
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signGaslessClaim(recvKey, freshSecret, recv, address(this), 100e18, deadline);

        // Different msg.sender → signature mismatch
        vm.prank(address(0xBAD));
        vm.expectRevert(ScatterSettlement.InvalidSignature.selector);
        settlement.claimReleaseFor(freshSecret, recv, 100e18, deadline, sig);
    }

    function test_gasless_claim_nonce_replay_reverts() public {
        uint256 recvKey = 0xABC;
        address recv = vm.addr(recvKey);
        bytes32 freshSecret = keccak256("nonce-replay-secret");

        tokenA.mint(maker, 20 ether);
        tokenB.mint(taker, 42_000e18);
        vm.prank(maker); settlement.deposit(address(tokenA), 20 ether);
        vm.prank(taker); settlement.deposit(address(tokenB), 42_000e18);

        // Create two separate settlements for the same recipient
        ScatterSettlement.ClaimInfo[] memory mc1 = new ScatterSettlement.ClaimInfo[](1);
        mc1[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo1 = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 610, claims: mc1
        });

        bytes32 freshSecret2 = keccak256("nonce-replay-secret2");
        ScatterSettlement.ClaimInfo[] memory mc2 = new ScatterSettlement.ClaimInfo[](1);
        mc2[0] = ScatterSettlement.ClaimInfo(_claimHash(freshSecret2, recv), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo2 = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 611, claims: mc2
        });

        ScatterSettlement.ClaimInfo[] memory tc1 = new ScatterSettlement.ClaimInfo[](1);
        tc1[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("nr-t1"), address(0xF1)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to1 = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 610, claims: tc1
        });
        ScatterSettlement.ClaimInfo[] memory tc2 = new ScatterSettlement.ClaimInfo[](1);
        tc2[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("nr-t2"), address(0xF2)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to2 = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 611, claims: tc2
        });

        settlement.settle(_signOrder(makerKey, mo1), _signOrder(takerKey, to1), mo1, to1, 0);
        settlement.settle(_signOrder(makerKey, mo2), _signOrder(takerKey, to2), mo2, to2, 0);
        vm.warp(block.timestamp + 4 hours);

        // First gasless claim succeeds (nonce=0)
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig1 = _signGaslessClaim(recvKey, freshSecret, recv, address(this), 0, deadline);
        settlement.claimReleaseFor(freshSecret, recv, 0, deadline, sig1);

        // Replay sig1 with secret2 → fails because nonce is now 1
        vm.expectRevert(ScatterSettlement.InvalidSignature.selector);
        settlement.claimReleaseFor(freshSecret2, recv, 0, deadline, sig1);
    }

    function test_refund_works_during_pause() public {
        vm.prank(maker); settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker); settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        bytes32 secret = keccak256("pause-refund");
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(secret, recipientC), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = _makeOrder(maker, 10 ether, 21_000e18, 0, 700, mc);
        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("pr-taker"), address(0xDDD)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = _makeOrder2(taker, 21_000e18, 10 ether, 0, 700, tc);

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);

        // Pause the contract
        settlement.setPaused(true);

        // Warp past refund window
        vm.warp(block.timestamp + 3 hours + 7 days + 1);

        // Refund should still work during pause (fund safety guarantee)
        bytes32 ch = _claimHash(secret, recipientC);
        vm.prank(maker);
        settlement.refundUnclaimed(ch);

        // Verify refund credited to escrow
        assertEq(settlement.deposits(maker, address(tokenB)), 21_000e18);
    }

    function test_settle_duplicate_claimHash_reverts() public {
        vm.prank(maker); settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker); settlement.deposit(address(tokenB), 21_000e18);

        bytes32 duplicateSecret = keccak256("duplicate-test");
        bytes32 ch = _claimHash(duplicateSecret, recipientC);

        // Two claims with the same claimHash — amounts sum to sellAmount (no fee)
        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](2);
        mc[0] = ScatterSettlement.ClaimInfo(ch, 11_000e18, 3 hours);
        mc[1] = ScatterSettlement.ClaimInfo(ch, 10_000e18, 3 hours); // duplicate claimHash!
        ScatterSettlement.Order memory mo = _makeOrder(maker, 10 ether, 21_000e18, 0, 800, mc);
        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("dup-taker"), address(0xAAA)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = _makeOrder2(taker, 21_000e18, 10 ether, 0, 800, tc);

        bytes memory ms = _signOrder(makerKey, mo);
        bytes memory ts = _signOrder(takerKey, to_);

        vm.expectRevert(ScatterSettlement.DuplicateClaimHash.selector);
        settlement.settle(ms, ts, mo, to_, 0);
    }

    function test_claim_verifies_token_balance() public {
        vm.prank(maker); settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker); settlement.deposit(address(tokenB), 21_000e18);

        bytes32 secret = keccak256("balance-check");
        ScatterSettlement.ClaimInfo[] memory mc = new ScatterSettlement.ClaimInfo[](1);
        mc[0] = ScatterSettlement.ClaimInfo(_claimHash(secret, recipientC), 21_000e18, 3 hours);
        ScatterSettlement.Order memory mo = _makeOrder(maker, 10 ether, 21_000e18, 0, 900, mc);
        ScatterSettlement.ClaimInfo[] memory tc = new ScatterSettlement.ClaimInfo[](1);
        tc[0] = ScatterSettlement.ClaimInfo(_claimHash(keccak256("bc-taker"), address(0xBBB)), 10 ether, 3 hours);
        ScatterSettlement.Order memory to_ = _makeOrder2(taker, 21_000e18, 10 ether, 0, 900, tc);

        settlement.settle(_signOrder(makerKey, mo), _signOrder(takerKey, to_), mo, to_, 0);
        vm.warp(block.timestamp + 4 hours);

        uint256 balBefore = tokenB.balanceOf(recipientC);
        vm.prank(recipientC);
        settlement.claimRelease(secret);
        uint256 balAfter = tokenB.balanceOf(recipientC);

        assertEq(balAfter - balBefore, 21_000e18, "Recipient should receive exact claim amount");
    }

    // ─── Helpers for compact test setup ─────────────────────────────

    function _makeOrder(address mk, uint256 sellAmt, uint256 buyAmt, uint256 maxFee, uint256 nonce, ScatterSettlement.ClaimInfo[] memory claims)
        internal view returns (ScatterSettlement.Order memory)
    {
        return ScatterSettlement.Order({
            maker: mk, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: sellAmt, buyAmount: buyAmt, maxFee: maxFee,
            expiry: block.timestamp + 1 days, nonce: nonce, claims: claims
        });
    }

    function _makeOrder2(address mk, uint256 sellAmt, uint256 buyAmt, uint256 maxFee, uint256 nonce, ScatterSettlement.ClaimInfo[] memory claims)
        internal view returns (ScatterSettlement.Order memory)
    {
        return ScatterSettlement.Order({
            maker: mk, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: sellAmt, buyAmount: buyAmt, maxFee: maxFee,
            expiry: block.timestamp + 1 days, nonce: nonce, claims: claims
        });
    }
}
