// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validateApproveInput, type ApproveInput } from "./validation";

function input(overrides: Partial<ApproveInput> = {}): ApproveInput {
  return {
    operator: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    commonName: "ops@example.com",
    organization: "Example",
    country: "KR",
    validityDays: "365",
    expiresAt: "0",
    ...overrides,
  };
}

const NOW = 1_700_000_000;

describe("validateApproveInput", () => {
  it("accepts a fully valid form", () => {
    const { valid, errors } = validateApproveInput(input(), NOW);
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });

  it("rejects an invalid operator address", () => {
    const { valid, errors } = validateApproveInput(input({ operator: "0xnope" }), NOW);
    expect(valid).toBe(false);
    expect(errors.operator).toMatch(/valid EVM address/i);
  });

  it("rejects the zero address (contract reverts ZeroOperator)", () => {
    const { valid, errors } = validateApproveInput(
      input({ operator: "0x" + "0".repeat(40) }),
      NOW,
    );
    expect(valid).toBe(false);
    expect(errors.operator).toMatch(/zero address/i);
  });

  it("trims whitespace before address-checking the operator", () => {
    const { valid } = validateApproveInput(
      input({ operator: "  0x70997970C51812dc3A010C7d01b50e0d17dc79C8  " }),
      NOW,
    );
    expect(valid).toBe(true);
  });

  it("rejects empty CN / organization / wrong-length country", () => {
    expect(validateApproveInput(input({ commonName: "  " }), NOW).errors.commonName).toBeDefined();
    expect(validateApproveInput(input({ organization: "" }), NOW).errors.organization).toBeDefined();
    expect(validateApproveInput(input({ country: "KOR" }), NOW).errors.country).toBeDefined();
    expect(validateApproveInput(input({ country: "K" }), NOW).errors.country).toBeDefined();
  });

  it("rejects validity out of 1..3650 range", () => {
    expect(validateApproveInput(input({ validityDays: "0" }), NOW).errors.validityDays).toBeDefined();
    expect(validateApproveInput(input({ validityDays: "3651" }), NOW).errors.validityDays).toBeDefined();
    expect(validateApproveInput(input({ validityDays: "abc" }), NOW).errors.validityDays).toBeDefined();
    expect(validateApproveInput(input({ validityDays: "365" }), NOW).errors.validityDays).toBeUndefined();
  });

  it("treats empty expiresAt as 0 (no expiry)", () => {
    expect(validateApproveInput(input({ expiresAt: "" }), NOW).valid).toBe(true);
    expect(validateApproveInput(input({ expiresAt: "   " }), NOW).valid).toBe(true);
  });

  it("rejects non-integer expiresAt", () => {
    expect(validateApproveInput(input({ expiresAt: "abc" }), NOW).errors.expiresAt).toBeDefined();
    expect(validateApproveInput(input({ expiresAt: "1.5" }), NOW).errors.expiresAt).toBeDefined();
    expect(validateApproveInput(input({ expiresAt: "-1" }), NOW).errors.expiresAt).toBeDefined();
  });

  it("rejects past expiresAt (would revert the on-chain approve)", () => {
    expect(
      validateApproveInput(input({ expiresAt: String(NOW - 1) }), NOW).errors.expiresAt,
    ).toBeDefined();
    expect(
      validateApproveInput(input({ expiresAt: String(NOW) }), NOW).errors.expiresAt,
    ).toBeDefined();
  });

  it("accepts future expiresAt", () => {
    const { valid, errors } = validateApproveInput(input({ expiresAt: String(NOW + 1) }), NOW);
    expect(valid).toBe(true);
    expect(errors.expiresAt).toBeUndefined();
  });

  it("returns multiple errors at once", () => {
    const { valid, errors } = validateApproveInput(
      input({ operator: "x", commonName: "", country: "ZZ Z", validityDays: "0" }),
      NOW,
    );
    expect(valid).toBe(false);
    expect(errors.operator).toBeDefined();
    expect(errors.commonName).toBeDefined();
    expect(errors.country).toBeDefined();
    expect(errors.validityDays).toBeDefined();
  });
});
