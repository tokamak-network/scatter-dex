// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title IssuanceApprovalRegistry
/// @notice Records an off-chain KYC admin's decision that a given
/// operator wallet is approved to receive a zk-X509 certificate from
/// the Relayer-CA. The operators app reads `approvals(wallet)` to gate
/// the "Open Relayer-CA portal" CTA — operators only see the cert-
/// issuance link after the admin has reviewed their ID + wallet pair
/// offline and recorded the decision here.
///
/// Why this contract instead of an off-chain database:
///   - **Auditable**: every approval / revocation is an event on a
///     public chain. Operators can verify they were approved without
///     trusting the admin's database.
///   - **Trust-minimised**: a multisig owner (RelayerRegistry pattern)
///     prevents a single admin key from rubber-stamping arbitrary
///     wallets.
///   - **No private material**: only metadata (CN / O / C / validity)
///     and admin attribution land here. The cert itself is issued
///     off-chain at the zk-X509 CA; this contract never sees the
///     keypair.
///
/// Scope vs IdentityRegistry:
///   - `IdentityRegistry` (zk-X509) holds the final on-chain
///     attestation that gates `RelayerRegistry.register(...)`.
///   - `IssuanceApprovalRegistry` (this contract) is the upstream
///     "this wallet is approved to *go get* a cert" signal — purely
///     UI/UX gating, not a security boundary. The cert issuance + ZK
///     proof verification at IdentityRegistry remain the actual
///     security check.
contract IssuanceApprovalRegistry is Ownable2Step {
    struct Approval {
        /// X.509 CN — typically the operator org email.
        string commonName;
        /// X.509 O — operator organisation name.
        string organization;
        /// X.509 C — ISO-3166 alpha-2 country code (e.g. "KR", "SG").
        string country;
        /// Expected cert validity at issuance time (days, 1..3650).
        uint32 validityDays;
        /// Admin wallet that recorded this approval. Surfaced in UIs
        /// so operators can see who reviewed their application.
        address approvedBy;
        /// Block timestamp when the approval was recorded.
        uint64 approvedAt;
        /// Approval auto-expires at this unix-seconds value. `0` =
        /// no expiry (legitimate when the issuance flow is expected
        /// to complete within a short window after approval).
        uint64 expiresAt;
        /// True once the admin revokes this approval.
        bool revoked;
        /// Free-form reason recorded at revoke time. Surfaced in
        /// audit logs.
        string revokeReason;
        uint64 revokedAt;
    }

    mapping(address => Approval) private _approvals;

    event ApprovalRecorded(
        address indexed operator,
        string commonName,
        string organization,
        string country,
        uint32 validityDays,
        address indexed approvedBy,
        uint64 approvedAt,
        uint64 expiresAt
    );
    event ApprovalRevoked(
        address indexed operator,
        address indexed revokedBy,
        uint64 revokedAt,
        string reason
    );

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Record an approval (or re-record one that was previously
    /// revoked — the new approval overwrites the prior state). Owner-
    /// only; in practice this is a multisig wallet.
    function approve(
        address operator,
        string calldata commonName,
        string calldata organization,
        string calldata country,
        uint32 validityDays,
        uint64 expiresAt
    ) external onlyOwner {
        require(operator != address(0), "operator=0");
        require(bytes(commonName).length > 0, "CN empty");
        require(bytes(organization).length > 0, "O empty");
        require(bytes(country).length == 2, "C must be ISO-3166 alpha-2");
        require(validityDays > 0 && validityDays <= 3650, "validity out of range");
        require(
            expiresAt == 0 || expiresAt > block.timestamp,
            "expiresAt must be 0 or in the future"
        );

        Approval storage a = _approvals[operator];
        a.commonName = commonName;
        a.organization = organization;
        a.country = country;
        a.validityDays = validityDays;
        a.approvedBy = msg.sender;
        a.approvedAt = uint64(block.timestamp);
        a.expiresAt = expiresAt;
        // Re-approval after a prior revoke: clear the revoked flag +
        // reason so the operator's UI flips back to "approved" state.
        a.revoked = false;
        a.revokeReason = "";
        a.revokedAt = 0;

        emit ApprovalRecorded(
            operator, commonName, organization, country, validityDays,
            msg.sender, uint64(block.timestamp), expiresAt
        );
    }

    /// @notice Revoke a previously-recorded approval. Owner-only.
    /// Doesn't delete history — the entry stays with `revoked=true`
    /// so admins can see who was previously approved and why they
    /// were revoked.
    function revoke(address operator, string calldata reason) external onlyOwner {
        Approval storage a = _approvals[operator];
        require(a.approvedAt != 0, "no approval to revoke");
        require(!a.revoked, "already revoked");
        a.revoked = true;
        a.revokeReason = reason;
        a.revokedAt = uint64(block.timestamp);
        emit ApprovalRevoked(operator, msg.sender, uint64(block.timestamp), reason);
    }

    /// @notice Full approval record for `operator`, including revoked
    /// state and history. Returns the zero-struct when the wallet was
    /// never approved (caller checks `approvedAt != 0`).
    function approvals(address operator) external view returns (Approval memory) {
        return _approvals[operator];
    }

    /// @notice Pure-view: is `wallet` currently approved + non-expired
    /// + non-revoked? The UI's primary gate.
    function isApproved(address wallet) external view returns (bool) {
        Approval storage a = _approvals[wallet];
        if (a.approvedAt == 0 || a.revoked) return false;
        if (a.expiresAt != 0 && block.timestamp >= a.expiresAt) return false;
        return true;
    }
}
