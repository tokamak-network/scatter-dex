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

  const operatorTrimmed = input.operator.trim();
  if (!ethers.isAddress(operatorTrimmed)) {
    errors.operator = "Enter a valid EVM address.";
  } else if (
    // ethers.isAddress accepts `0x0000…0000` as a valid address, but
    // the contract rejects it with ZeroOperator. Catch it here so
    // the user sees an inline message instead of a tx revert.
    operatorTrimmed.toLowerCase() === "0x" + "0".repeat(40)
  ) {
    errors.operator = "Address must not be the zero address.";
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

/** Days-until-expiry classification with a per-bucket UI tone.
 *  Pure for testability; renderer maps `tone` to colours. Day count
 *  is calendar-day-truncated, not seconds-rounded — "expires in 0
 *  days" means "today or already past, not 23 hours from now".
 *
 *  `tone`:
 *  - `expired`: already past (negative remaining)
 *  - `urgent`: ≤ 7 days
 *  - `warn`: ≤ 30 days
 *  - `ok`: > 30 days
 *  - `none`: no expiry configured (expiresAt === 0) */
export interface ApprovalWindow {
  tone: "none" | "ok" | "warn" | "urgent" | "expired";
  days: number;
  /** Pre-rendered text suitable for inline display. */
  label: string;
}

export function classifyApprovalWindow(
  expiresAt: number,
  nowSec: number,
): ApprovalWindow {
  if (expiresAt === 0) {
    return { tone: "none", days: Infinity, label: "no expiry" };
  }
  const secPerDay = 86_400;
  const diff = expiresAt - nowSec;
  // Past: use floor on the elapsed seconds (NOT Math.ceil on the
  // signed diff) so a 1h-ago expiry classifies as `0d` elapsed and
  // reads "expired today" — past-tense. The previous Math.ceil
  // approach made any past-but-< 24h expiry render "expires today"
  // (future-tense), which read like the approval was still good
  // for the rest of the day.
  if (diff <= 0) {
    const elapsedDays = Math.floor(-diff / secPerDay);
    return {
      tone: "expired",
      days: -elapsedDays,
      label: elapsedDays === 0 ? "expired today" : `expired ${elapsedDays}d ago`,
    };
  }
  // Future: Math.ceil so 5h-from-now reads as "1 day" not "0 days"
  // — the operator should see the partial day rounded UP into the
  // next bucket.
  const days = Math.ceil(diff / secPerDay);
  if (days <= 7) {
    return { tone: "urgent", days, label: `expires in ${days}d` };
  }
  if (days <= 30) {
    return { tone: "warn", days, label: `expires in ${days}d` };
  }
  return { tone: "ok", days, label: `expires in ${days}d` };
}
