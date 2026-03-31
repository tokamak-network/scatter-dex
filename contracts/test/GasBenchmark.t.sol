// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract BenchToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract GasBenchmarkTest is Test {
    ScatterSettlement public settlement;
    IdentityGate public gate;
    RelayerRegistry public relayerRegistry;
    MockIdentityRegistry public registry;
    BenchToken public tokenA;
    BenchToken public tokenB;

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
        MockIdentityRegistry relayerIdRegistry = new MockIdentityRegistry();
        relayerIdRegistry.setVerified(address(this), true);
        relayerRegistry = new RelayerRegistry(treasury, address(relayerIdRegistry));
        settlement = new ScatterSettlement(address(gate), address(relayerRegistry), 0);

        tokenA = new BenchToken("Token A", "TKA");
        tokenB = new BenchToken("Token B", "TKB");

        settlement.setTokenWhitelist(address(tokenA), true);
        settlement.setTokenWhitelist(address(tokenB), true);

        registry.setVerified(maker, true);
        registry.setVerified(taker, true);

        relayerRegistry.register{value: 0.1 ether}("http://localhost", 30);

        tokenA.mint(maker, 1000 ether);
        tokenB.mint(taker, 2_100_000e18);

        vm.prank(maker);
        tokenA.approve(address(settlement), type(uint256).max);
        vm.prank(taker);
        tokenB.approve(address(settlement), type(uint256).max);
    }

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
                order.maker, order.sellToken, order.buyToken,
                order.sellAmount, order.buyAmount, order.maxFee,
                order.expiry, order.nonce,
                keccak256(abi.encodePacked(claimHashes))
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ScatterSettlement"), keccak256("1"),
                block.chainid, address(settlement)
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Deposit (first deposit = cold storage)
    // ═══════════════════════════════════════════════════════════════
    function test_gas_deposit_first() public {
        vm.prank(maker);
        uint256 gasBefore = gasleft();
        settlement.deposit(address(tokenA), 10 ether);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("DEPOSIT (first/cold):", gasUsed);
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Deposit (second deposit = warm storage)
    // ═══════════════════════════════════════════════════════════════
    function test_gas_deposit_second() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);

        vm.prank(maker);
        uint256 gasBefore = gasleft();
        settlement.deposit(address(tokenA), 10 ether);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("DEPOSIT (second/warm):", gasUsed);
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Withdraw
    // ═══════════════════════════════════════════════════════════════
    function test_gas_withdraw() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);

        vm.prank(maker);
        uint256 gasBefore = gasleft();
        settlement.withdraw(address(tokenA), 10 ether);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("WITHDRAW:", gasUsed);
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Settle (3+1 claims, paper's reference scenario)
    // ═══════════════════════════════════════════════════════════════
    function test_gas_settle_3plus1() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](3);
        makerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret1, recipientC), 7000e18, 3 hours);
        makerClaims[1] = ScatterSettlement.ClaimInfo(_claimHash(secret2, recipientD), 8000e18, 6 hours);
        makerClaims[2] = ScatterSettlement.ClaimInfo(_claimHash(secret3, recipientE), 6000e18, 9 hours);

        ScatterSettlement.Order memory makerOrder = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: makerClaims
        });

        ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
        takerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret4, recipientF), 10 ether, 4 hours);

        ScatterSettlement.Order memory takerOrder = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: takerClaims
        });

        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);

        uint256 gasBefore = gasleft();
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0, 0);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("SETTLE (3+1 claims):", gasUsed);
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Claim
    // ═══════════════════════════════════════════════════════════════
    function test_gas_claim() public {
        // Setup: deposit + settle
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](3);
        makerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret1, recipientC), 7000e18, 3 hours);
        makerClaims[1] = ScatterSettlement.ClaimInfo(_claimHash(secret2, recipientD), 8000e18, 6 hours);
        makerClaims[2] = ScatterSettlement.ClaimInfo(_claimHash(secret3, recipientE), 6000e18, 9 hours);

        ScatterSettlement.Order memory makerOrder = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: makerClaims
        });

        ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
        takerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret4, recipientF), 10 ether, 4 hours);

        ScatterSettlement.Order memory takerOrder = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: takerClaims
        });

        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0, 0);

        // Claim: recipientC claims schedule 0 after releaseTime
        vm.warp(block.timestamp + 3 hours);
        vm.prank(recipientC);
        uint256 gasBefore = gasleft();
        settlement.claimRelease(secret1);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("CLAIM (single):", gasUsed);
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Refund
    // ═══════════════════════════════════════════════════════════════
    function test_gas_refund() public {
        vm.prank(maker);
        settlement.deposit(address(tokenA), 10 ether);
        vm.prank(taker);
        settlement.deposit(address(tokenB), 21_000e18);

        ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](3);
        makerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret1, recipientC), 7000e18, 3 hours);
        makerClaims[1] = ScatterSettlement.ClaimInfo(_claimHash(secret2, recipientD), 8000e18, 6 hours);
        makerClaims[2] = ScatterSettlement.ClaimInfo(_claimHash(secret3, recipientE), 6000e18, 9 hours);

        ScatterSettlement.Order memory makerOrder = ScatterSettlement.Order({
            maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
            sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: makerClaims
        });

        ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
        takerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret4, recipientF), 10 ether, 4 hours);

        ScatterSettlement.Order memory takerOrder = ScatterSettlement.Order({
            maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
            sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
            expiry: block.timestamp + 1 days, nonce: 1, claims: takerClaims
        });

        bytes memory makerSig = _signOrder(makerKey, makerOrder);
        bytes memory takerSig = _signOrder(takerKey, takerOrder);
        settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0, 0);

        // Refund schedule 0 after REFUND_WINDOW
        vm.warp(block.timestamp + 3 hours + 7 days + 1);
        vm.prank(maker);
        uint256 gasBefore = gasleft();
        settlement.refundUnclaimed(_claimHash(secret1, recipientC));
        uint256 gasUsed = gasBefore - gasleft();
        console.log("REFUND:", gasUsed);
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Total scenario (paper's reference)
    // deposit + deposit + settle(3+1) + 3 claims + 1 claim
    // ═══════════════════════════════════════════════════════════════
    function test_gas_total_scenario() public {
        uint256[7] memory gas_;

        // Deposit maker
        vm.prank(maker);
        gas_[0] = gasleft();
        settlement.deposit(address(tokenA), 10 ether);
        gas_[0] = gas_[0] - gasleft();

        // Deposit taker
        vm.prank(taker);
        gas_[1] = gasleft();
        settlement.deposit(address(tokenB), 21_000e18);
        gas_[1] = gas_[1] - gasleft();

        // Settle
        {
            ScatterSettlement.ClaimInfo[] memory makerClaims = new ScatterSettlement.ClaimInfo[](3);
            makerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret1, recipientC), 7000e18, 3 hours);
            makerClaims[1] = ScatterSettlement.ClaimInfo(_claimHash(secret2, recipientD), 8000e18, 6 hours);
            makerClaims[2] = ScatterSettlement.ClaimInfo(_claimHash(secret3, recipientE), 6000e18, 9 hours);

            ScatterSettlement.Order memory makerOrder = ScatterSettlement.Order({
                maker: maker, sellToken: address(tokenA), buyToken: address(tokenB),
                sellAmount: 10 ether, buyAmount: 21_000e18, maxFee: 0,
                expiry: block.timestamp + 1 days, nonce: 1, claims: makerClaims
            });

            ScatterSettlement.ClaimInfo[] memory takerClaims = new ScatterSettlement.ClaimInfo[](1);
            takerClaims[0] = ScatterSettlement.ClaimInfo(_claimHash(secret4, recipientF), 10 ether, 4 hours);

            ScatterSettlement.Order memory takerOrder = ScatterSettlement.Order({
                maker: taker, sellToken: address(tokenB), buyToken: address(tokenA),
                sellAmount: 21_000e18, buyAmount: 10 ether, maxFee: 0,
                expiry: block.timestamp + 1 days, nonce: 1, claims: takerClaims
            });

            bytes memory makerSig = _signOrder(makerKey, makerOrder);
            bytes memory takerSig = _signOrder(takerKey, takerOrder);

            gas_[2] = gasleft();
            settlement.settle(makerSig, takerSig, makerOrder, takerOrder, 0, 0);
            gas_[2] = gas_[2] - gasleft();
        }

        // Claims
        vm.warp(block.timestamp + 9 hours + 1);

        vm.prank(recipientC);
        gas_[3] = gasleft();
        settlement.claimRelease(secret1);
        gas_[3] = gas_[3] - gasleft();

        vm.prank(recipientD);
        gas_[4] = gasleft();
        settlement.claimRelease(secret2);
        gas_[4] = gas_[4] - gasleft();

        vm.prank(recipientE);
        gas_[5] = gasleft();
        settlement.claimRelease(secret3);
        gas_[5] = gas_[5] - gasleft();

        vm.prank(recipientF);
        gas_[6] = gasleft();
        settlement.claimRelease(secret4);
        gas_[6] = gas_[6] - gasleft();

        console.log("=== FULL SCENARIO GAS REPORT ===");
        console.log("Deposit (maker, cold):", gas_[0]);
        console.log("Deposit (taker, cold):", gas_[1]);
        console.log("Settle (3+1 claims):  ", gas_[2]);
        console.log("Claim 1 (recipientC): ", gas_[3]);
        console.log("Claim 2 (recipientD): ", gas_[4]);
        console.log("Claim 3 (recipientE): ", gas_[5]);
        console.log("Claim 4 (recipientF): ", gas_[6]);
        console.log("--- TOTALS ---");
        console.log("Total deposits:       ", gas_[0] + gas_[1]);
        console.log("Total claims:         ", gas_[3] + gas_[4] + gas_[5] + gas_[6]);
        console.log("GRAND TOTAL:          ", gas_[0] + gas_[1] + gas_[2] + gas_[3] + gas_[4] + gas_[5] + gas_[6]);

        // Gas regression bounds — fail if settle exceeds 350K or total exceeds 650K
        assertLt(gas_[2], 350_000, "settle gas regression");
        assertLt(gas_[0] + gas_[1] + gas_[2] + gas_[3] + gas_[4] + gas_[5] + gas_[6], 650_000, "total gas regression");
    }

    // ═══════════════════════════════════════════════════════════════
    // Gas Benchmark: Cancel order
    // ═══════════════════════════════════════════════════════════════
    function test_gas_cancelOrder() public {
        vm.prank(maker);
        uint256 gasBefore = gasleft();
        settlement.cancelOrder(999);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("CANCEL ORDER:", gasUsed);
    }
}
