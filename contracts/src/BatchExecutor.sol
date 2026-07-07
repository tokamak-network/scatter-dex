// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  BatchExecutor — minimal ERC-7579-compatible delegate for EIP-7702
/// @notice Designed to be the target of an EOA's EIP-7702 authorization.
///         When an EOA delegates to this address it can execute a batch of
///         calls in a single transaction — e.g. `WETH.deposit{value}()` +
///         `WETH.approve(pool, amt)` + `pool.deposit(...)` — collapsing
///         three MetaMask popups into one.
///
/// @dev    Only the ERC-7579 `CALLTYPE_BATCH + EXECTYPE_DEFAULT` mode is
///         implemented. Other modes (single, delegate, try/revert) revert
///         with `UnsupportedCallType` / `UnsupportedExecType`. This keeps
///         the contract small and easy to audit; zkScatter's frontend only
///         uses batch mode.
///
///         `execute` may only be invoked with `msg.sender == address(this)`.
///         Under 7702, that means only the delegating EOA (which runs this
///         bytecode while the delegation is active) can call its own
///         `execute`. A third-party tx to the EOA's address calling
///         `execute(...)` would fail this check because `msg.sender` would
///         be the third party, not the EOA itself.
contract BatchExecutor {
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    // ERC-7579 mode layout (first two bytes of the mode bytes32):
    //   byte 0 = callType (0x00=single, 0x01=batch, 0xff=delegate)
    //   byte 1 = execType (0x00=default/revert, 0x01=try)
    bytes1 internal constant CALLTYPE_BATCH = 0x01;
    bytes1 internal constant EXECTYPE_DEFAULT = 0x00;

    error NotAuthorizedCaller();
    error UnsupportedCallType(bytes1 callType);
    error UnsupportedExecType(bytes1 execType);
    error UnsupportedModeFields(bytes32 mode);
    error ExecutionFailed(uint256 index, bytes returnData);

    // Mask over bytes 2..31 of the ERC-7579 mode — the reserved bytes,
    // modeSelector, and modePayload. This minimal executor accepts only
    // (batch, default) with no selector/payload, so anything non-zero
    // past the first two bytes implies extended semantics we don't
    // honor. Rejecting explicitly prevents clients from silently
    // invoking an unimplemented ERC-7821 / 7579 extension.
    bytes32 internal constant MODE_TAIL_MASK = 0x0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    /// @notice ERC-7579 execute entrypoint.
    /// @param  mode              Packed call/exec type (see above).
    /// @param  executionCalldata ABI-encoded `Execution[]` for batch mode.
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable {
        if (msg.sender != address(this)) revert NotAuthorizedCaller();

        bytes1 callType = mode[0];
        bytes1 execType = mode[1];
        if (callType != CALLTYPE_BATCH) revert UnsupportedCallType(callType);
        if (execType != EXECTYPE_DEFAULT) revert UnsupportedExecType(execType);
        if ((mode & MODE_TAIL_MASK) != bytes32(0)) revert UnsupportedModeFields(mode);

        // Memory decode keeps the contract small. Typical batches are 2-3
        // calls so the allocation cost is trivial vs. the gas a delegated
        // execution already spends.
        Execution[] memory calls = abi.decode(executionCalldata, (Execution[]));

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].callData);
            if (!ok) revert ExecutionFailed(i, ret);
        }
    }

    /// @notice Helper for clients that prefer to build the mode bytes32
    ///         off-chain. Returns the canonical batch/default mode value
    ///         this contract accepts.
    function batchMode() external pure returns (bytes32) {
        // Only the first two bytes matter; remaining bytes (selector +
        // modeData per ERC-7579) are unused by this minimal executor.
        return bytes32(uint256(uint8(CALLTYPE_BATCH)) << 248);
    }

    /// @notice Accept ETH so payable batch calls can draw from the EOA's
    ///         balance via `value` on individual executions. Without this,
    ///         a bare ETH transfer to the delegated EOA would still work
    ///         (EOAs accept ETH by default), but explicitly marking the
    ///         contract payable avoids any surprise under future compiler
    ///         stricture.
    receive() external payable {}
}
