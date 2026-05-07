// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StealthTransferAccount} from "../src/StealthTransferAccount.sol";

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
        // Query the EIP-712 typed-data digest from the delegated EOA
        // — the domain separator binds against `address(this) = stealth`,
        // so calling the contract directly (against its deploy address)
        // would yield a different digest that the verifier would reject.
        uint256 currentNonce = StealthTransferAccount(stealth).nonce();
        // Re-pack calldata to satisfy the `calldata` parameter type on
        // hashBatch — `vm.signAndAttachDelegation`'s view-call path
        // only handles ABI-encoded calldata.
        StealthTransferAccount.Call[] memory cloned = calls;
        bytes32 digest = StealthTransferAccount(stealth).hashBatch(currentNonce, cloned);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(stealthKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _delegate() internal {
        vm.signAndAttachDelegation(address(account), stealthKey);
    }

    function testHappyPathTokenTransfer() public {
        _delegate();
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](2);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 100e6)
        });
        calls[1] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, feeCollector, 1e6)
        });

        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        StealthTransferAccount(stealth).executeBatch(calls, sig);

        assertEq(token.balanceOf(recipient), 100e6, "recipient credited");
        assertEq(token.balanceOf(feeCollector), 1e6, "fee collected");
        assertEq(token.balanceOf(stealth), 1_000e6 - 101e6, "stealth debited");
        assertEq(StealthTransferAccount(stealth).nonce(), 1, "nonce advanced");
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
        StealthTransferAccount(stealth).executeBatch(calls, sig);

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

        // Sign with an attacker key — recover() returns a different
        // address than `stealth` and the verifier rejects.
        uint256 attackerKey = 0xBADBAD;
        bytes32 digest = StealthTransferAccount(stealth).hashBatch(0, calls);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerKey, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        vm.expectRevert(StealthTransferAccount.InvalidSignature.selector);
        StealthTransferAccount(stealth).executeBatch(calls, badSig);
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
        StealthTransferAccount(stealth).executeBatch(calls, sig);

        // Same sig — nonce has advanced, so the digest the contract
        // recomputes uses nonce=1 while the sig was over nonce=0 →
        // recover yields a different address and the verifier rejects.
        vm.prank(relayer);
        vm.expectRevert(StealthTransferAccount.InvalidSignature.selector);
        StealthTransferAccount(stealth).executeBatch(calls, sig);
    }

    function testRevertPropagatesInnerCallFailure() public {
        _delegate();
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 9_999e6)
        });
        bytes memory sig = _signBatch(calls);

        // Pin the failure surface: the inner ERC20 transfer reverts
        // with `Error("insufficient")`, which the wrapper repackages
        // as `CallFailed(0, abi.encode(Error("insufficient")))`.
        // Asserting both the selector AND the index guarantees the
        // test fails if a regression makes the call succeed for a
        // different reason or fail at a different index.
        bytes memory innerRevert = abi.encodeWithSignature("Error(string)", "insufficient");
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(StealthTransferAccount.CallFailed.selector, uint256(0), innerRevert)
        );
        StealthTransferAccount(stealth).executeBatch(calls, sig);
    }

    function testNonceLivesAtEOAUnderDelegation() public {
        _delegate();
        // Deployed contract's storage stays at 0 — every state write
        // happens at the EOA's address under 7702.
        assertEq(account.nonce(), 0, "delegate contract storage untouched");

        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 1e6)
        });
        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        StealthTransferAccount(stealth).executeBatch(calls, sig);

        assertEq(account.nonce(), 0, "delegate contract still untouched");
        assertEq(StealthTransferAccount(stealth).nonce(), 1, "EOA nonce advanced");
    }

    function testReentrancyGuardedByNonceBump() public {
        _delegate();

        // Build a batch whose first call re-enters into the EOA's
        // executeBatch with the SAME signature. Because executeBatch
        // bumps nonce *before* dispatching subcalls, the re-entry
        // sees nonce=1 while the sig is over nonce=0 → invalid sig
        // → outer call surfaces it as CallFailed.
        StealthTransferAccount.Call[] memory inner = new StealthTransferAccount.Call[](1);
        inner[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 1e6)
        });
        // Sign for nonce=0 (the outer call's nonce). The inner reuse
        // would need this sig to also be valid for nonce=1 — it isn't.
        bytes memory innerSig = _signBatch(inner);

        StealthTransferAccount.Call[] memory outer = new StealthTransferAccount.Call[](1);
        outer[0] = StealthTransferAccount.Call({
            target: stealth, // re-enter the EOA
            value: 0,
            data: abi.encodeWithSelector(StealthTransferAccount.executeBatch.selector, inner, innerSig)
        });
        bytes memory outerSig = _signBatch(outer);

        vm.prank(relayer);
        vm.expectRevert(); // CallFailed wrapping the inner InvalidSignature
        StealthTransferAccount(stealth).executeBatch(outer, outerSig);
    }

    function testZeroCallBatchAdvancesNonceWithoutSideEffects() public {
        _delegate();
        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](0);
        bytes memory sig = _signBatch(calls);

        vm.prank(relayer);
        StealthTransferAccount(stealth).executeBatch(calls, sig);

        // No funds moved, nonce still advanced. Documented behavior:
        // a signed empty batch is a valid "burn this nonce" op (e.g.
        // for cancelling a pending sig).
        assertEq(StealthTransferAccount(stealth).nonce(), 1);
        assertEq(token.balanceOf(stealth), 1_000e6);
    }

    function testCrossChainSignatureRejected() public {
        _delegate();

        StealthTransferAccount.Call[] memory calls = new StealthTransferAccount.Call[](1);
        calls[0] = StealthTransferAccount.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSelector(MockERC20.transfer.selector, recipient, 1e6)
        });

        // Sign on chain X (id=999) for the same EOA + nonce + calls.
        uint256 originalChainId = block.chainid;
        vm.chainId(999);
        bytes memory foreignSig = _signBatch(calls);
        vm.chainId(originalChainId);

        // Submit on the original chain — domain separator differs by
        // chainId, so the recovered signer doesn't match `stealth`.
        vm.prank(relayer);
        vm.expectRevert(StealthTransferAccount.InvalidSignature.selector);
        StealthTransferAccount(stealth).executeBatch(calls, foreignSig);
    }
}
