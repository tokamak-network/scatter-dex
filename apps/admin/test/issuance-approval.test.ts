import { describe, expect, it } from "vitest";
import { classifyApproval } from "../app/lib/useIssuanceApproval";

const NOW = 1_700_000_000;

// Minimal RawApproval (the on-chain struct shape) for the pure classifier.
const base = {
  commonName: "ops@example.io",
  organization: "Example Ops",
  country: "KR",
  validityDays: 365n,
  approvedBy: "0x000000000000000000000000000000000000dEaD",
  approvedAt: 0n,
  expiresAt: 0n,
  revoked: false,
  revokeReason: "",
  revokedAt: 0n,
};

describe("classifyApproval", () => {
  it("not-approved when approvedAt == 0 (no row)", () => {
    expect(classifyApproval({ ...base }, NOW).status).toBe("not-approved");
  });

  it("approved when recorded, not revoked, no expiry", () => {
    const r = classifyApproval({ ...base, approvedAt: 100n }, NOW);
    expect(r.status).toBe("approved");
    expect(r.approval?.commonName).toBe("ops@example.io");
  });

  it("revoked takes precedence over expiry, with reason", () => {
    const r = classifyApproval(
      { ...base, approvedAt: 100n, revoked: true, revokeReason: "kyc lapsed" },
      NOW,
    );
    expect(r.status).toBe("revoked");
    expect(r.revokeReason).toBe("kyc lapsed");
  });

  it("expired when nowSec > expiresAt (non-zero)", () => {
    expect(
      classifyApproval({ ...base, approvedAt: 100n, expiresAt: BigInt(NOW - 1) }, NOW).status,
    ).toBe("expired");
  });

  it("expired exactly at expiresAt (chain uses >= on read)", () => {
    expect(
      classifyApproval({ ...base, approvedAt: 100n, expiresAt: BigInt(NOW) }, NOW).status,
    ).toBe("expired");
  });

  it("approved one second before expiry", () => {
    expect(
      classifyApproval({ ...base, approvedAt: 100n, expiresAt: BigInt(NOW + 1) }, NOW).status,
    ).toBe("approved");
  });

  it("no expiry (expiresAt == 0) stays approved regardless of now", () => {
    expect(
      classifyApproval({ ...base, approvedAt: 100n, expiresAt: 0n }, NOW + 10_000_000).status,
    ).toBe("approved");
  });
});
