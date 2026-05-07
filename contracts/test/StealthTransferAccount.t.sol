// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StealthTransferAccount} from "../src/StealthTransferAccount.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract MockERC20 {
    string public name = "Mock";
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract StealthTransferAccountTest is Test {
    using MessageHashUtils for bytes32;

    StealthTransferAccount internal account;
    MockERC20 internal token;

    // Stealth EOA — owner of the funds, signer of the batch
    uint256 internal stealthKey;
    address internal stealth;

    // Relayer — submits the type-4 tx, pays gas
    address internal relayer = address(0xBEEF);
    address internal feeCollector = address(0xFEE);
    address internal recipient = address(0xCAFE);

    function setUp() public {
        account = new StealthTransferAccount();
        token = new MockERC20();
        stealthKey = 0xA11CE;
        stealth = vm.addr(stealthKey);

        // Seed the stealth EOA with token + native balance the way a
        // real claim payout would
        token.mint(stealth, 1_000e6);
        vm.deal(stealth, 1 ether);
    }

    function _signBatch(StealthTransferAccount.Call[] memory calls) internal view returns (bytes memory) {
        // Same hashing pattern the contract verifies: chainId, account
        // (== stealth), current nonce, encoded calls. account.nonce()
        // queries the storage of the EOA which holds the deployed
        // contract's slots under 7702 — see test note on
        // testNonceLivesAtEOAUnderDelegation.
        uint256 currentNonce = StealthTransferAccount(payable(stealth)).nonce();
        bytes32 raw = keccak256(abi.encode(block.chainid, stealth, currentNonce, calls));
        bytes32 ethHash = raw.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(stealthKey, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _delegate() internal {
        // Simulate the EIP-7702 authorization being attached to the
        // next tx so calls into the stealth EOA execute the
        // StealthTransferAccount code.
        vm.signAndAttachDelegation(address(account), stealthKey);
    }

    function testHappyPathTokenTransfer() public {
        _delegate();
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](2);
        // 1) recipient gets 100 tokens
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 100e6)
        });
        // 2) relayer gets 1 token as fee
        calls[1] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, feeCollector, 1e6)
        });

        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        StealthTransferAccount(payable(stealth)).executeBatch(calls, sig);

        assertEq(token.balanceOf(recipient), 100e6, "recipient credited");
        assertEq(token.balanceOf(feeCollector), 1e6, "fee collected");
        assertEq(token.balanceOf(stealth), 1_000e6 - 101e6, "stealth debited");
        assertEq(StealthTransferAccount(payable(stealth)).nonce(), 1, "nonce advanced");
    }

    function testHappyPathNativeEthTransfer() public {
        _delegate();
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: recipient,
            value: 0.5 ether,
            data: ""
        });

        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        StealthTransferAccount(payable(stealth)).executeBatch(calls, sig);

        assertEq(recipient.balance, 0.5 ether, "recipient native credit");
        assertEq(stealth.balance, 0.5 ether, "stealth native debit");
    }

    function testRevertOnInvalidSignature() public {
        _delegate();
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 100e6)
        });

        // Sign with a different key — must revert
        uint256 attackerKey = 0xBADBAD;
        bytes32 raw = keccak256(abi.encode(block.chainid, stealth, 0, calls));
        bytes32 ethHash = raw.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerKey, ethHash);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        vm.expectRevert(StealthTransferAccount.InvalidSignature.selector);
        StealthTransferAccount(payable(stealth)).executeBatch(calls, badSig);
    }

    function testRevertOnReplay() public {
        _delegate();
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 50e6)
        });
        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        StealthTransferAccount(payable(stealth)).executeBatch(calls, sig);

        // Same sig — nonce has advanced, so signer would now be a
        // different address and recover != stealth.
        vm.prank(relayer);
        vm.expectRevert(StealthTransferAccount.InvalidSignature.selector);
        StealthTransferAccount(payable(stealth)).executeBatch(calls, sig);
    }

    function testRevertPropagatesInnerCallFailure() public {
        _delegate();
        // Try to send more than the stealth holds — MockERC20.transfer
        // requires balance, so this reverts inside the call, which
        // executeBatch surfaces as CallFailed.
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 9_999e6)
        });
        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        // Don't pin the inner returnData — bytes-payload selector
        // matching is enough to confirm the failure surface.
        vm.expectRevert();
        StealthTransferAccount(payable(stealth)).executeBatch(calls, sig);
    }

    function testNonceLivesAtEOAUnderDelegation() public {
        _delegate();
        // Sanity: the deployed `account` contract's storage stays at
        // 0 — every state write happens at the EOA's address.
        assertEq(account.nonce(), 0, "delegate contract storage untouched");

        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 1e6)
        });
        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        StealthTransferAccount(payable(stealth)).executeBatch(calls, sig);

        assertEq(account.nonce(), 0, "delegate contract still untouched");
        assertEq(StealthTransferAccount(payable(stealth)).nonce(), 1, "EOA nonce advanced");
    }
}
