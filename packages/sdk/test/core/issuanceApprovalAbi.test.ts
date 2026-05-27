import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { ISSUANCE_APPROVAL_REGISTRY_ABI } from "../../src/core/contracts";

// Regression test for the ABI shape of `approvals(address)`.
// `IssuanceApprovalRegistry.approvals` returns the `Approval` struct
// as a SINGLE tuple, not a flat list of fields. A flat form here
// would compile cleanly (the ABI fragment is valid) but fail at
// runtime with `data out-of-bounds` once a real call returns data.
// Catching that requires actually round-tripping bytes through
// ethers — neither the SDK typecheck nor the operator-side hook
// unit tests exercise the decoder.
describe("ISSUANCE_APPROVAL_REGISTRY_ABI — approvals() decode", () => {
  const iface = new ethers.Interface(ISSUANCE_APPROVAL_REGISTRY_ABI);

  it("decodes the Approval struct as a single named tuple", () => {
    const sample = {
      commonName: "relayer3@tokamak.network",
      organization: "Tokamak Network",
      country: "KR",
      validityDays: 365,
      approvedBy: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      approvedAt: 1_700_000_000n,
      expiresAt: 0n,
      revoked: false,
      revokeReason: "",
      revokedAt: 0n,
    };

    // Encode as Solidity would: one tuple wrapped in the function's
    // returns(...) list.
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "tuple(string,string,string,uint32,address,uint64,uint64,bool,string,uint64)",
      ],
      [
        [
          sample.commonName,
          sample.organization,
          sample.country,
          sample.validityDays,
          sample.approvedBy,
          sample.approvedAt,
          sample.expiresAt,
          sample.revoked,
          sample.revokeReason,
          sample.revokedAt,
        ],
      ],
    );

    const [result] = iface.decodeFunctionResult("approvals", encoded);

    // Named-field access is what every consumer relies on
    // (`raw.commonName`, `raw.approvedAt`, …). If the ABI is
    // flat-form, decoder returns 10 top-level values and result[0]
    // is just the first string — these assertions catch that.
    expect(result.commonName).toBe(sample.commonName);
    expect(result.organization).toBe(sample.organization);
    expect(result.country).toBe(sample.country);
    expect(Number(result.validityDays)).toBe(sample.validityDays);
    expect((result.approvedBy as string).toLowerCase()).toBe(
      sample.approvedBy.toLowerCase(),
    );
    expect(result.approvedAt).toBe(sample.approvedAt);
    expect(result.expiresAt).toBe(sample.expiresAt);
    expect(result.revoked).toBe(false);
    expect(result.revokeReason).toBe("");
    expect(result.revokedAt).toBe(0n);
  });

  it("decodes the zero-struct returned for an unknown wallet", () => {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "tuple(string,string,string,uint32,address,uint64,uint64,bool,string,uint64)",
      ],
      [["", "", "", 0, ethers.ZeroAddress, 0n, 0n, false, "", 0n]],
    );

    const [result] = iface.decodeFunctionResult("approvals", encoded);

    // `approvedAt === 0` is the sentinel `classifyApproval` uses to
    // distinguish "no row" from "approved at unix-zero" — the field
    // must be reachable by name.
    expect(result.approvedAt).toBe(0n);
    expect(result.commonName).toBe("");
  });

  it("exposes the contract's custom errors by name", () => {
    // Pick one that the admin console surfaces in its catch path —
    // without the error fragment, `iface.getError("ValidityOutOfRange")`
    // returns null and the UI shows raw selector hex.
    const err = iface.getError("ValidityOutOfRange");
    expect(err).not.toBeNull();
    expect(err!.name).toBe("ValidityOutOfRange");
  });
});
