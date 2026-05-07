// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

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
 *  EIP-7702, not a bug. The EIP-712 signature check below is what
 *  gates whether the call is allowed to move E's funds: only a
 *  payload signed by E's own privkey + matching the on-chain nonce
 *  can pass. Cross-chain replay is bound out by chainId in the
 *  EIP-712 domain separator.
 *
 *  EIP-712 under 7702
 *  ==================
 *  OZ's `EIP712` base caches the domain separator with `address(this)`
 *  recorded at construction. Under 7702, `address(this)` at call time
 *  is the EOA — different from the deployed contract address — so
 *  the cache check fails and `_domainSeparatorV4()` rebuilds with
 *  the EOA bound in. Each delegating EOA therefore gets its own
 *  domain separator, which is what we want for per-account replay
 *  protection.
 *
 *  Storage layout (slot 0 = `nonce`)
 *  =================================
 *  Under EIP-7702 storage reads/writes target the called account's
 *  slots — so each delegating EOA holds its own `nonce` at its own
 *  address. Stealth addresses in Pay are one-shot (one claim, one
 *  transfer), so the nonce typically never advances past 0/1, but
 *  the counter still hardens against an accidental double-submit.
 */
contract StealthTransferAccount is EIP712 {
    using ECDSA for bytes32;

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

    /// @dev EIP-712 typehash for `Call`. Must match the order and
    ///      types of the `Call` struct fields.
    bytes32 private constant CALL_TYPEHASH =
        keccak256("Call(address target,uint256 value,bytes data)");

    /// @dev EIP-712 typehash for the batch. The trailing `Call(...)`
    ///      definition is required by EIP-712 — referenced types are
    ///      appended in alphabetical order.
    bytes32 private constant BATCH_TYPEHASH =
        keccak256(
            "Batch(uint256 nonce,Call[] calls)Call(address target,uint256 value,bytes data)"
        );

    error InvalidSignature();
    error CallFailed(uint256 index, bytes returnData);

    /// @notice Emitted after every successful batch so off-chain
    ///         indexers can reconcile. `caller` is the relayer that
    ///         submitted the tx; the EOA = `address(this)`.
    event BatchExecuted(address indexed caller, uint256 indexed nonce, uint256 callsCount);

    constructor() EIP712("StealthTransferAccount", "1") {}

    /**
     *  Execute a batch of arbitrary calls from the delegating EOA.
     *  The relayer is `msg.sender`; the EOA is `address(this)` (an
     *  EIP-7702 delegation property). The EIP-712 signature must be
     *  produced by the EOA's privkey over the typed-data digest of
     *  `Batch(nonce, calls)`. After verification, the nonce is
     *  bumped before any external call so a re-entrant call into
     *  `executeBatch` would see a stale signature and revert.
     *
     *  @param calls      Ordered list of subcalls. Native value can
     *                    be attached per-call (sourced from this
     *                    contract's balance, i.e. the EOA's balance).
     *  @param signature  65-byte ECDSA signature over the EIP-712
     *                    typed-data hash of the batch.
     */
    function executeBatch(Call[] calldata calls, bytes calldata signature) external {
        address account = address(this);
        uint256 currentNonce = nonce;

        bytes32 digest = _hashTypedDataV4(_hashBatch(currentNonce, calls));
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

    /// @notice Compute the EIP-712 struct hash for a batch payload.
    ///         Exposed so off-chain signers can mirror the hashing
    ///         logic without duplicating typehash strings.
    function hashBatch(uint256 batchNonce, Call[] calldata calls) external view returns (bytes32) {
        return _hashTypedDataV4(_hashBatch(batchNonce, calls));
    }

    function _hashBatch(uint256 batchNonce, Call[] calldata calls) internal pure returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; ) {
            callHashes[i] = keccak256(
                abi.encode(CALL_TYPEHASH, calls[i].target, calls[i].value, keccak256(calls[i].data))
            );
            unchecked {
                ++i;
            }
        }
        return keccak256(abi.encode(BATCH_TYPEHASH, batchNonce, keccak256(abi.encodePacked(callHashes))));
    }
}
