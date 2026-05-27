/**
 * Client-side validators for the /admin/issuance Approve form.
 * Extracted so they can be unit-tested in isolation — every rule
 * mirrors a contract-side custom-error gate in
 * `IssuanceApprovalRegistry.approve(...)`, so this layer's job is
 * to catch bad inputs before the user pays gas.
 */
import { ethers } from "ethers";

export interface ApproveInput {
  operator: string;
  commonName: string;
  organization: string;
  country: string;
  validityDays: string;
  expiresAt: string;
}

export interface ApproveValidation {
  valid: boolean;
  errors: Partial<Record<keyof ApproveInput, string>>;
}

/** Returns `{ valid, errors }`. `valid === true` ⇒ no errors and
 *  every required field passes the contract's own predicates. */
export function validateApproveInput(
  input: ApproveInput,
  nowSec: number,
): ApproveValidation {
  const errors: Partial<Record<keyof ApproveInput, string>> = {};

  if (!ethers.isAddress(input.operator.trim())) {
    errors.operator = "Enter a valid EVM address.";
  }
  if (input.commonName.trim().length === 0) {
    errors.commonName = "CN is required.";
  }
  if (input.organization.trim().length === 0) {
    errors.organization = "Organization is required.";
  }
  if (input.country.trim().length !== 2) {
    errors.country = "Country must be ISO-3166 alpha-2 (2 letters).";
  }
  const v = Number(input.validityDays);
  if (!Number.isFinite(v) || v <= 0 || v > 3650) {
    errors.validityDays = "Validity must be 1..3650 days.";
  }
  // expiresAt is decimal-string from a text input; treat empty
  // string as 0 (= "no expiry"). Negative numbers, NaN, and
  // anything else rejected here so the on-chain custom-error
  // never fires.
  const trimmedExpiry = input.expiresAt.trim();
  const expirySource = trimmedExpiry === "" ? "0" : trimmedExpiry;
  let expiryNum: number;
  if (!/^\d+$/.test(expirySource)) {
    errors.expiresAt = "Must be a non-negative integer (or empty / 0 for no expiry).";
    expiryNum = NaN;
  } else {
    expiryNum = Number(expirySource);
    if (!Number.isFinite(expiryNum)) {
      errors.expiresAt = "Out of range.";
    } else if (expiryNum !== 0 && expiryNum <= nowSec) {
      // Mirrors the contract: `expiresAt != 0 && expiresAt <= block.timestamp` reverts.
      // Catching it here saves the user a failed tx.
      errors.expiresAt = "Expires-at must be 0 (no expiry) or a future unix-seconds timestamp.";
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}
