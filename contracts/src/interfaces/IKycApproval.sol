// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface for the admin KYC-approval registry.
/// @dev Implemented by `IssuanceApprovalRegistry`. The registration gate only needs the
///      boolean approval check; the full approve/revoke/approvals API stays on the concrete
///      contract. Kept deliberately narrow so `RelayerRegistry.register()` can't come to
///      depend on anything beyond "is this wallet currently approved?".
interface IKycApproval {
    /// @notice Whether `wallet` currently holds a valid admin KYC approval
    ///         (approved, non-revoked, and not past its expiry).
    function isApproved(address wallet) external view returns (bool);
}
