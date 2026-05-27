// @vitest-environment node
import { describe, it, expect } from "vitest";
import { classifyApprovalWindow, validateApproveInput, type ApproveInput } from "./validation";

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

describe("classifyApprovalWindow", () => {
  const NOW_SEC = 1_700_000_000;
  const DAY = 86_400;

  it("returns `none` tone when expiresAt is 0 (no expiry)", () => {
    const w = classifyApprovalWindow(0, NOW_SEC);
    expect(w.tone).toBe("none");
    expect(w.label).toBe("no expiry");
  });

  it("buckets > 30 days as `ok`", () => {
    const w = classifyApprovalWindow(NOW_SEC + 60 * DAY, NOW_SEC);
    expect(w.tone).toBe("ok");
    expect(w.days).toBe(60);
    expect(w.label).toBe("expires in 60d");
  });

  it("buckets ≤ 30d > 7d as `warn`", () => {
    expect(classifyApprovalWindow(NOW_SEC + 30 * DAY, NOW_SEC).tone).toBe("warn");
    expect(classifyApprovalWindow(NOW_SEC + 8 * DAY, NOW_SEC).tone).toBe("warn");
  });

  it("buckets ≤ 7d as `urgent`", () => {
    expect(classifyApprovalWindow(NOW_SEC + 7 * DAY, NOW_SEC).tone).toBe("urgent");
    expect(classifyApprovalWindow(NOW_SEC + 1 * DAY, NOW_SEC).tone).toBe("urgent");
  });

  it("marks `expired` for past timestamps and a special label for today", () => {
    const today = classifyApprovalWindow(NOW_SEC, NOW_SEC);
    expect(today.tone).toBe("expired");
    expect(today.label).toBe("expires today");

    const yesterday = classifyApprovalWindow(NOW_SEC - DAY, NOW_SEC);
    expect(yesterday.tone).toBe("expired");
    expect(yesterday.label).toBe("expired 1d ago");
  });

  it("ceils partial days so a 5h-from-now expiry reads as `1d` not `0d`", () => {
    const fiveHrs = NOW_SEC + 5 * 3600;
    const w = classifyApprovalWindow(fiveHrs, NOW_SEC);
    expect(w.days).toBe(1);
    expect(w.tone).toBe("urgent");
  });
});
