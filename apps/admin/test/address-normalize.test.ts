import { describe, expect, it } from "vitest";
import { isValidEvmAddress, normalizeEvmAddress } from "../app/lib/x509";

// Vitalik's address — canonical EIP-55 checksum form.
const VITALIK_CHECKSUMMED = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const VITALIK_LOWER = VITALIK_CHECKSUMMED.toLowerCase();
const VITALIK_UPPER = "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045";

describe("isValidEvmAddress", () => {
  it("accepts canonical checksum", () => {
    expect(isValidEvmAddress(VITALIK_CHECKSUMMED)).toBe(true);
  });

  it("accepts all-lowercase", () => {
    expect(isValidEvmAddress(VITALIK_LOWER)).toBe(true);
  });

  it("accepts mixed-case typos (syntactic only — no checksum check)", () => {
    // First nibble after 0x flipped d8 → d9. Mixed-case typos are
    // exactly what normalizeEvmAddress is supposed to catch — the
    // syntactic gate intentionally lets them through.
    expect(isValidEvmAddress("0xd9dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(true);
  });

  it("rejects too-short input", () => {
    expect(isValidEvmAddress("0xabc")).toBe(false);
  });

  it("rejects non-hex chars", () => {
    expect(isValidEvmAddress("0xggggggggggggggggggggggggggggggggggggggg0")).toBe(false);
  });
});

describe("normalizeEvmAddress", () => {
  it("normalizes lowercase to canonical checksum", () => {
    expect(normalizeEvmAddress(VITALIK_LOWER)).toBe(VITALIK_CHECKSUMMED);
  });

  it("normalizes uppercase to canonical checksum", () => {
    expect(normalizeEvmAddress(VITALIK_UPPER)).toBe(VITALIK_CHECKSUMMED);
  });

  it("returns the same value for an already-checksummed input", () => {
    expect(normalizeEvmAddress(VITALIK_CHECKSUMMED)).toBe(VITALIK_CHECKSUMMED);
  });

  it("REGRESSION: rejects mixed-case typos that break the EIP-55 checksum", () => {
    // One nibble flipped from the canonical form. ethers' getAddress
    // throws on this, normalizeEvmAddress returns null.
    const typo = "0xd9dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    expect(normalizeEvmAddress(typo)).toBe(null);
  });

  it("returns null on malformed input", () => {
    expect(normalizeEvmAddress("0xabc")).toBe(null);
    expect(normalizeEvmAddress("")).toBe(null);
    expect(normalizeEvmAddress("not-an-address")).toBe(null);
  });
});
