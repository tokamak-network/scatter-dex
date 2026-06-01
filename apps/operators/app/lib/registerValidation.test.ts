import { describe, it, expect } from "vitest";
import { normalizeName, validateEmail, validateRelayerUrl } from "./registerValidation";

describe("normalizeName", () => {
  it("trims outer whitespace", () => {
    expect(normalizeName("  Relayer A  ")).toBe("relayer a");
  });
  it("lower-cases", () => {
    expect(normalizeName("Relayer-A")).toBe("relayer-a");
  });
  it("collapses internal whitespace to a single space", () => {
    expect(normalizeName("Relayer    A\tB")).toBe("relayer a b");
  });
  it("returns empty string for whitespace-only input", () => {
    expect(normalizeName("    \t\n  ")).toBe("");
  });
  it("treats `Relayer A` and `  relayer   a ` as collisions", () => {
    expect(normalizeName("Relayer A")).toBe(normalizeName("  relayer   a "));
  });
});

describe("validateRelayerUrl", () => {
  it("flags empty input as empty (not invalid)", () => {
    expect(validateRelayerUrl("")).toEqual({ empty: true, invalid: false });
    expect(validateRelayerUrl("   ")).toEqual({ empty: true, invalid: false });
  });
  it("accepts https and http", () => {
    expect(validateRelayerUrl("https://relayer.example.com"))
      .toEqual({ empty: false, invalid: false });
    expect(validateRelayerUrl("http://localhost:3002"))
      .toEqual({ empty: false, invalid: false });
  });
  it("rejects non-http(s) protocols", () => {
    expect(validateRelayerUrl("ftp://relayer.example.com").invalid).toBe(true);
    expect(validateRelayerUrl("javascript:alert(1)").invalid).toBe(true);
    expect(validateRelayerUrl("file:///etc/passwd").invalid).toBe(true);
  });
  it("rejects a missing scheme", () => {
    expect(validateRelayerUrl("relayer.example.com").invalid).toBe(true);
  });
  it("rejects a hostname-less authority", () => {
    expect(validateRelayerUrl("https://").invalid).toBe(true);
  });
  it("rejects garbage that fails URL parsing", () => {
    expect(validateRelayerUrl("not a url at all").invalid).toBe(true);
  });
});

describe("validateEmail", () => {
  it("accepts a normal address", () => {
    expect(validateEmail("op@company.com")).toBe(true);
    expect(validateEmail("a.b+tag@sub.example.co")).toBe(true);
  });
  it("trims surrounding whitespace before checking", () => {
    expect(validateEmail("  op@company.com  ")).toBe(true);
  });
  it("rejects empty / whitespace-only input", () => {
    expect(validateEmail("")).toBe(false);
    expect(validateEmail("   ")).toBe(false);
  });
  it("rejects a missing @, domain, or TLD dot", () => {
    expect(validateEmail("opcompany.com")).toBe(false);
    expect(validateEmail("op@")).toBe(false);
    expect(validateEmail("op@company")).toBe(false);
  });
  it("rejects internal whitespace", () => {
    expect(validateEmail("op @company.com")).toBe(false);
    expect(validateEmail("op@comp any.com")).toBe(false);
  });
});
