// @vitest-environment node
/**
 * Unit tests for `classifyApproval` — the pure 7-state classifier
 * extracted from `useIssuanceApproval` so we can exercise every
 * branch (not-approved / approved / revoked / expired) without
 * standing up a contract or React renderer.
 */
import { describe, it, expect } from "vitest";
import { classifyApproval } from "./useIssuanceApproval";

function rawApproval(overrides: Partial<{
  commonName: string;
  organization: string;
  country: string;
  validityDays: bigint;
  approvedBy: string;
  approvedAt: bigint;
  expiresAt: bigint;
  revoked: boolean;
  revokeReason: string;
  revokedAt: bigint;
}> = {}) {
  return {
    commonName: "ops@example.com",
    organization: "Example",
    country: "KR",
    validityDays: 365n,
    approvedBy: "0x000000000000000000000000000000000000adad",
    approvedAt: 1_700_000_000n,
    expiresAt: 0n,
    revoked: false,
    revokeReason: "",
    revokedAt: 0n,
    ...overrides,
  };
}

describe("classifyApproval", () => {
  it("returns not-approved when the mapping returns the zero struct (approvedAt=0)", () => {
    const r = classifyApproval(
      rawApproval({
        approvedAt: 0n,
        commonName: "",
        organization: "",
        country: "",
        approvedBy: "0x" + "0".repeat(40),
      }),
      1_700_000_500,
    );
    expect(r.status).toBe("not-approved");
    expect(r.approval).toBeUndefined();
  });

  it("returns approved with the recorded metadata when non-expired + non-revoked", () => {
    const r = classifyApproval(rawApproval(), 1_700_000_500);
    expect(r.status).toBe("approved");
    expect(r.approval).toMatchObject({
      commonName: "ops@example.com",
      organization: "Example",
      country: "KR",
      validityDays: 365,
      approvedAt: 1_700_000_000,
      expiresAt: 0,
    });
  });

  it("returns revoked with the recorded reason", () => {
    const r = classifyApproval(
      rawApproval({ revoked: true, revokeReason: "lost key", revokedAt: 1_700_000_100n }),
      1_700_000_500,
    );
    expect(r.status).toBe("revoked");
    expect(r.revokeReason).toBe("lost key");
    expect(r.approval).toBeDefined();
  });

  it("falls back to a sentinel reason when revoked with empty reason string", () => {
    const r = classifyApproval(
      rawApproval({ revoked: true, revokeReason: "" }),
      1_700_000_500,
    );
    expect(r.status).toBe("revoked");
    expect(r.revokeReason).toBe("(no reason supplied)");
  });

  it("revoked takes precedence over expired", () => {
    // Both revoked AND expired — operator's actionable next step is
    // "contact admin about revocation", not "wait for re-approval".
    const r = classifyApproval(
      rawApproval({
        revoked: true,
        revokeReason: "policy",
        expiresAt: 1_700_000_100n,
      }),
      1_700_000_500,
    );
    expect(r.status).toBe("revoked");
  });

  it("returns expired when expiresAt is non-zero and now >= expiresAt", () => {
    // Exact boundary — mirrors the contract's >= rejection check.
    const r = classifyApproval(
      rawApproval({ expiresAt: 1_700_000_100n }),
      1_700_000_100,
    );
    expect(r.status).toBe("expired");
    expect(r.approval).toBeDefined();
  });

  it("returns approved when expiresAt is non-zero but now < expiresAt", () => {
    const r = classifyApproval(
      rawApproval({ expiresAt: 1_700_000_500n }),
      1_700_000_499,
    );
    expect(r.status).toBe("approved");
  });

  it("treats expiresAt=0 as no-expiry (approved indefinitely)", () => {
    // Far-future now() — would have flipped expired if the 0 weren't
    // special-cased.
    const r = classifyApproval(rawApproval({ expiresAt: 0n }), 2_000_000_000);
    expect(r.status).toBe("approved");
  });

  it("coerces uint64/uint32 bigints to plain numbers in the exposed approval", () => {
    const r = classifyApproval(
      rawApproval({
        validityDays: 90n,
        approvedAt: 1_700_000_000n,
        expiresAt: 1_700_001_000n,
      }),
      1_700_000_500,
    );
    if (r.status !== "approved") throw new Error("expected approved branch");
    expect(typeof r.approval!.validityDays).toBe("number");
    expect(typeof r.approval!.approvedAt).toBe("number");
    expect(typeof r.approval!.expiresAt).toBe("number");
    expect(r.approval!.validityDays).toBe(90);
  });
});
