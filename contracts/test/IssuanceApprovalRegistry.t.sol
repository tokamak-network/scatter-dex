// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IssuanceApprovalRegistry} from "../src/IssuanceApprovalRegistry.sol";

contract IssuanceApprovalRegistryTest is Test {
    IssuanceApprovalRegistry public reg;
    address admin = address(0xAD);
    address operator1 = address(0xA1);
    address operator2 = address(0xA2);

    function setUp() public {
        vm.prank(admin);
        reg = new IssuanceApprovalRegistry(admin);
    }

    function _approve(address op) internal {
        vm.prank(admin);
        reg.approve(op, "ops@example.com", "Example", "KR", 365, 0);
    }

    function test_RecordApprovalSurfacesIsApproved() public {
        assertFalse(reg.isApproved(operator1));
        _approve(operator1);
        assertTrue(reg.isApproved(operator1));

        IssuanceApprovalRegistry.Approval memory a = reg.approvals(operator1);
        assertEq(a.commonName, "ops@example.com");
        assertEq(a.organization, "Example");
        assertEq(a.country, "KR");
        assertEq(uint256(a.validityDays), 365);
        assertEq(a.approvedBy, admin);
        assertGt(uint256(a.approvedAt), 0);
        assertFalse(a.revoked);
    }

    function test_OnlyOwnerCanApprove() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator1));
        vm.prank(operator1);
        reg.approve(operator1, "x@x", "X", "KR", 1, 0);
    }

    function test_RejectsZeroOperator() public {
        vm.prank(admin);
        vm.expectRevert(bytes("operator=0"));
        reg.approve(address(0), "x@x", "X", "KR", 1, 0);
    }

    function test_RejectsEmptyCN() public {
        vm.prank(admin);
        vm.expectRevert(bytes("CN empty"));
        reg.approve(operator1, "", "X", "KR", 1, 0);
    }

    function test_RejectsBadCountryCode() public {
        vm.prank(admin);
        vm.expectRevert(bytes("C must be ISO-3166 alpha-2"));
        reg.approve(operator1, "x@x", "X", "KOR", 1, 0);
    }

    function test_RejectsValidityOutOfRange() public {
        vm.startPrank(admin);
        vm.expectRevert(bytes("validity out of range"));
        reg.approve(operator1, "x@x", "X", "KR", 0, 0);
        vm.expectRevert(bytes("validity out of range"));
        reg.approve(operator1, "x@x", "X", "KR", 3651, 0);
        vm.stopPrank();
    }

    function test_RejectsExpiresAtInThePast() public {
        vm.warp(1_000_000);
        vm.prank(admin);
        vm.expectRevert(bytes("expiresAt must be 0 or in the future"));
        reg.approve(operator1, "x@x", "X", "KR", 1, uint64(block.timestamp - 1));
    }

    function test_AcceptsExpiresAtInTheFutureOrZero() public {
        vm.warp(1_000_000);
        vm.startPrank(admin);
        reg.approve(operator1, "x@x", "X", "KR", 1, 0);
        reg.approve(operator1, "x@x", "X", "KR", 1, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    function test_ExpiryFlipsIsApprovedToFalse() public {
        vm.warp(1_000_000);
        uint64 expiry = uint64(block.timestamp + 10);
        vm.prank(admin);
        reg.approve(operator1, "x@x", "X", "KR", 1, expiry);
        assertTrue(reg.isApproved(operator1));
        vm.warp(expiry);
        assertFalse(reg.isApproved(operator1));
    }

    function test_RevokeFlipsIsApprovedAndStampsHistory() public {
        _approve(operator1);
        vm.prank(admin);
        reg.revoke(operator1, "found on sanctions list");
        assertFalse(reg.isApproved(operator1));
        IssuanceApprovalRegistry.Approval memory a = reg.approvals(operator1);
        assertTrue(a.revoked);
        assertEq(a.revokeReason, "found on sanctions list");
        assertGt(uint256(a.revokedAt), 0);
        assertEq(a.approvedBy, admin);
    }

    function test_RevokeRejectsUnapprovedWallet() public {
        vm.prank(admin);
        vm.expectRevert(bytes("no approval to revoke"));
        reg.revoke(operator1, "");
    }

    function test_RevokeRejectsDoubleRevoke() public {
        _approve(operator1);
        vm.prank(admin);
        reg.revoke(operator1, "r1");
        vm.prank(admin);
        vm.expectRevert(bytes("already revoked"));
        reg.revoke(operator1, "r2");
    }

    function test_OnlyOwnerCanRevoke() public {
        _approve(operator1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator2));
        vm.prank(operator2);
        reg.revoke(operator1, "");
    }

    function test_ReApprovalClearsRevokeState() public {
        _approve(operator1);
        vm.prank(admin);
        reg.revoke(operator1, "mistake");
        assertFalse(reg.isApproved(operator1));
        vm.prank(admin);
        reg.approve(operator1, "ops2@example.com", "Example v2", "SG", 90, 0);
        assertTrue(reg.isApproved(operator1));
        IssuanceApprovalRegistry.Approval memory a = reg.approvals(operator1);
        assertEq(a.commonName, "ops2@example.com");
        assertEq(a.organization, "Example v2");
        assertEq(a.country, "SG");
        assertEq(uint256(a.validityDays), 90);
        assertFalse(a.revoked);
        assertEq(a.revokeReason, "");
        assertEq(uint256(a.revokedAt), 0);
    }

    function test_ZeroStructForUnknownWallet() public view {
        IssuanceApprovalRegistry.Approval memory a = reg.approvals(operator1);
        assertEq(uint256(a.approvedAt), 0);
        assertEq(a.approvedBy, address(0));
    }
}
