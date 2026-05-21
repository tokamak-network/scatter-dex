// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BatchExecutor} from "../src/BatchExecutor.sol";

contract Sink {
    uint256 public last;
    address public lastCaller;
    event Hit(uint256 v, uint256 ethReceived, address caller);

    function ping(uint256 v) external payable {
        last = v;
        lastCaller = msg.sender;
        emit Hit(v, msg.value, msg.sender);
    }

    function alwaysRevert() external pure {
        revert("nope");
    }
}

/// @notice Exercises BatchExecutor as if it were delegated to an EOA.
///         Calling `executor.execute(...)` from `address(executor)` itself
///         (via `vm.prank`) mirrors the EIP-7702 case where the EOA runs
///         this bytecode and invokes its own execute.
contract BatchExecutorTest is Test {
    BatchExecutor executor;
    Sink sinkA;
    Sink sinkB;

    bytes32 constant BATCH_DEFAULT_MODE = bytes32(uint256(1) << 248);
    bytes32 constant BATCH_TRY_MODE = bytes32((uint256(1) << 248) | (uint256(1) << 240));
    bytes32 constant SINGLE_DEFAULT = bytes32(0);

    function setUp() public {
        executor = new BatchExecutor();
        sinkA = new Sink();
        sinkB = new Sink();
    }

    function _calldata(BatchExecutor.Execution[] memory calls) internal pure returns (bytes memory) {
        return abi.encode(calls);
    }

    function test_rejects_non_self_caller() public {
        BatchExecutor.Execution[] memory calls = new BatchExecutor.Execution[](1);
        calls[0] = BatchExecutor.Execution(address(sinkA), 0, abi.encodeCall(Sink.ping, (1)));

        vm.expectRevert(BatchExecutor.NotAuthorizedCaller.selector);
        executor.execute(BATCH_DEFAULT_MODE, _calldata(calls));
    }

    function test_rejects_single_calltype() public {
        bytes memory empty = abi.encode(new BatchExecutor.Execution[](0));
        vm.prank(address(executor));
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.UnsupportedCallType.selector, bytes1(0)));
        executor.execute(SINGLE_DEFAULT, empty);
    }

    function test_rejects_try_exectype() public {
        bytes memory empty = abi.encode(new BatchExecutor.Execution[](0));
        vm.prank(address(executor));
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.UnsupportedExecType.selector, bytes1(0x01)));
        executor.execute(BATCH_TRY_MODE, empty);
    }

    function test_rejects_nonzero_mode_tail() public {
        // Batch/default callType+execType but with a non-zero modeSelector
        // (bytes 6..9). Should be rejected — this minimal executor doesn't
        // honor ERC-7821 / ERC-7579 selector extensions.
        bytes32 modeWithSelector = bytes32((uint256(1) << 248) | (uint256(0xdeadbeef) << 176));
        bytes memory empty = abi.encode(new BatchExecutor.Execution[](0));
        vm.prank(address(executor));
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.UnsupportedModeFields.selector, modeWithSelector));
        executor.execute(modeWithSelector, empty);
    }

    function test_rejects_nonzero_reserved_bytes() public {
        // Reserved bytes (2..5) must be zero per ERC-7579.
        bytes32 modeWithReserved = bytes32((uint256(1) << 248) | (uint256(0xff) << 232));
        bytes memory empty = abi.encode(new BatchExecutor.Execution[](0));
        vm.prank(address(executor));
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.UnsupportedModeFields.selector, modeWithReserved));
        executor.execute(modeWithReserved, empty);
    }

    function test_empty_batch_is_noop() public {
        bytes memory empty = abi.encode(new BatchExecutor.Execution[](0));
        vm.prank(address(executor));
        executor.execute(BATCH_DEFAULT_MODE, empty);
        // Nothing to assert beyond "didn't revert".
    }

    function test_batch_executes_in_order() public {
        BatchExecutor.Execution[] memory calls = new BatchExecutor.Execution[](2);
        calls[0] = BatchExecutor.Execution(address(sinkA), 0, abi.encodeCall(Sink.ping, (7)));
        calls[1] = BatchExecutor.Execution(address(sinkB), 0, abi.encodeCall(Sink.ping, (11)));

        vm.prank(address(executor));
        executor.execute(BATCH_DEFAULT_MODE, _calldata(calls));

        assertEq(sinkA.last(), 7);
        assertEq(sinkB.last(), 11);
        // Under real 7702, `lastCaller` would be the EOA. Here it's the
        // executor itself because we're simulating by pranking as the
        // executor's own address.
        assertEq(sinkA.lastCaller(), address(executor));
    }

    function test_batch_propagates_value() public {
        BatchExecutor.Execution[] memory calls = new BatchExecutor.Execution[](1);
        calls[0] = BatchExecutor.Execution(address(sinkA), 1 ether, abi.encodeCall(Sink.ping, (42)));

        vm.deal(address(executor), 1 ether);
        vm.prank(address(executor));
        executor.execute{value: 1 ether}(BATCH_DEFAULT_MODE, _calldata(calls));

        assertEq(sinkA.last(), 42);
        assertEq(address(sinkA).balance, 1 ether);
    }

    function test_batch_reverts_on_inner_failure_with_index() public {
        BatchExecutor.Execution[] memory calls = new BatchExecutor.Execution[](3);
        calls[0] = BatchExecutor.Execution(address(sinkA), 0, abi.encodeCall(Sink.ping, (1)));
        calls[1] = BatchExecutor.Execution(address(sinkA), 0, abi.encodeCall(Sink.alwaysRevert, ()));
        calls[2] = BatchExecutor.Execution(address(sinkA), 0, abi.encodeCall(Sink.ping, (99)));

        vm.prank(address(executor));
        // Encoded `Error("nope")` is the ABI revert payload.
        bytes memory retNope = abi.encodeWithSignature("Error(string)", "nope");
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.ExecutionFailed.selector, uint256(1), retNope));
        executor.execute(BATCH_DEFAULT_MODE, _calldata(calls));

        // Whole batch is atomic — successful index 0 must be rolled back
        // too. `last` should still be the pre-tx value (0).
        assertEq(sinkA.last(), 0);
    }

    function test_batchMode_helper_matches_accepted_mode() public view {
        assertEq(executor.batchMode(), BATCH_DEFAULT_MODE);
    }
}
