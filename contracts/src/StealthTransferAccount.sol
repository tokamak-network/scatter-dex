// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 *  Minimal smart-account that an EOA delegates to via EIP-7702 so a
 *  relayer can submit a batched transfer + fee payment on the EOA's
 *  behalf. The recipient signs the batched call payload off-chain (no
 *  gas), the relayer pays the on-chain gas in native ETH and recovers
 *  the cost as a token-denominated fee included in the batch.
 *
 *  Threat model
 *  ============
 *  Once an EOA E delegates to this contract via 7702, *anyone* can
 *  call into E and execute its delegated code — that's a property of
 *  EIP-7702, not a bug. The signature check below is what gates
 *  whether the call is allowed to move E's funds: only a payload
 *  signed by E's own privkey + matching the on-chain nonce can
 *  pass. Replay across chains is prevented by binding the signed
 *  hash to `block.chainid`.
 *
 *  Storage layout (slot 0 = `nonce`)
 *  =================================
 *  Under EIP-7702, storage reads/writes target the called account's
 *  slots — so each delegating EOA holds its own `nonce` at its own
 *  address. Stealth addresses in Pay are one-shot (one claim, one
 *  transfer), so the nonce typically never advances past 0/1, but
 *  the counter still hardens against an accidental double-submit.
 */
contract StealthTransferAccount {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// @dev Per-EOA replay counter. Lives in the EOA's slot 0 under
    ///      7702 delegation; reset semantics if the EOA later
    ///      delegates to a contract with a different layout.
    uint256 public nonce;

    /// @notice Single call inside a batched execution.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    error InvalidSignature();
    error CallFailed(uint256 index, bytes returnData);

    /// @notice Emitted after every successful batch so off-chain
    ///         indexers can reconcile. `caller` is the relayer that
    ///         submitted the tx; the EOA = `address(this)`.
    event BatchExecuted(address indexed caller, uint256 indexed nonce, uint256 callsCount);

    /**
     *  Execute a batch of arbitrary calls from the delegating EOA.
     *  The relayer is `msg.sender`; the EOA is `address(this)` (an
     *  EIP-7702 delegation property). The signature must be produced
     *  by the EOA's privkey over the Ethereum-prefixed hash of
     *  `(chainId, account, nonce, calls)`. After verification, the
     *  nonce is bumped before any external call so a re-entrant
     *  call into `executeBatch` would see a stale signature and
     *  revert.
     *
     *  @param calls      Ordered list of subcalls. Native value can
     *                    be attached per-call (sourced from this
     *                    contract's balance, i.e. the EOA's balance).
     *  @param signature  65-byte ECDSA signature over the eth-signed
     *                    hash of the encoded params.
     */
    function executeBatch(Call[] calldata calls, bytes calldata signature) external {
        address account = address(this);
        uint256 currentNonce = nonce;

        bytes32 digest = keccak256(
            abi.encode(block.chainid, account, currentNonce, calls)
        ).toEthSignedMessageHash();
        address signer = digest.recover(signature);
        if (signer != account) revert InvalidSignature();

        // Bump first so a re-entrant call into `executeBatch` sees a
        // stale nonce and reverts before touching funds again.
        nonce = currentNonce + 1;

        uint256 len = calls.length;
        for (uint256 i = 0; i < len; ) {
            Call calldata c = calls[i];
            (bool ok, bytes memory ret) = c.target.call{value: c.value}(c.data);
            if (!ok) revert CallFailed(i, ret);
            unchecked {
                ++i;
            }
        }

        emit BatchExecuted(msg.sender, currentNonce, len);
    }

    /// Required to receive native ETH refunds from any of the
    /// internal calls (e.g. WETH unwrap that returns dust).
    receive() external payable {}
}
