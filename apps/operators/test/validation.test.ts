import { describe, expect, it } from "vitest";
import { parseEth, parseFeeBps } from "../app/lib/validation";

describe("parseFeeBps", () => {
  it("rejects empty input with a hint to enter a value", () => {
    const r = parseFeeBps("", 500);
    expect(r).toEqual({ ok: false, reason: "Enter a fee in bps before saving." });
  });

  it("rejects whitespace-only input", () => {
    expect(parseFeeBps("   ", 500).ok).toBe(false);
  });

  it("rejects negative values", () => {
    const r = parseFeeBps("-1", 500);
    expect(r.ok).toBe(false);
  });

  it("rejects fractional values", () => {
    const r = parseFeeBps("30.5", 500);
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric strings", () => {
    expect(parseFeeBps("zero", 500).ok).toBe(false);
  });

  it("rejects values above the cap", () => {
    const r = parseFeeBps("501", 500);
    expect(r).toEqual({
      ok: false,
      reason: "feeBps must be an integer between 0 and 500.",
    });
  });

  it("accepts zero", () => {
    expect(parseFeeBps("0", 500)).toEqual({ ok: true, value: 0 });
  });

  it("accepts the cap exactly", () => {
    expect(parseFeeBps("500", 500)).toEqual({ ok: true, value: 500 });
  });

  it("accepts a typical mid-range value with surrounding whitespace", () => {
    expect(parseFeeBps("  30  ", 500)).toEqual({ ok: true, value: 30 });
  });

  it("accepts higher caps when caller passes them (e.g. platform fee)", () => {
    expect(parseFeeBps("1000", 10_000)).toEqual({ ok: true, value: 1000 });
  });
});

describe("parseEth", () => {
  it("parses a whole-ETH input", () => {
    expect(parseEth("1")).toBe(10n ** 18n);
  });

  it("parses a fractional input", () => {
    expect(parseEth("0.5")).toBe(5n * 10n ** 17n);
  });

  it("accepts leading-decimal form (.5 == 0.5)", () => {
    expect(parseEth(".5")).toBe(5n * 10n ** 17n);
  });

  it("zero-pads short fractions to 18 digits", () => {
    expect(parseEth("0.000000000000000001")).toBe(1n);
  });

  it("rejects more than 18 fractional digits (no silent truncation)", () => {
    expect(parseEth("0.0000000000000000001")).toBeNull();
  });

  it("rejects negative values", () => {
    expect(parseEth("-1")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseEth("zero")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseEth("")).toBeNull();
  });

  it("rejects scientific notation", () => {
    expect(parseEth("1e18")).toBeNull();
  });
});
