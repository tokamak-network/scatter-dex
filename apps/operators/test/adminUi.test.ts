import { describe, expect, it } from "vitest";
import { formatEth, shortHex } from "../app/lib/adminUi";

describe("formatEth", () => {
  it("renders 1 ETH with four fractional digits", () => {
    expect(formatEth("1000000000000000000")).toBe("1.0000");
  });

  it("renders 0.5 ETH", () => {
    expect(formatEth("500000000000000000")).toBe("0.5000");
  });

  it("renders sub-wei dust as 0.0000", () => {
    expect(formatEth("1")).toBe("0.0000");
  });

  it("renders large balances without scientific notation", () => {
    expect(formatEth("123456000000000000000000")).toBe("123456.0000");
  });

  it("falls back to the raw string on unparseable input", () => {
    expect(formatEth("not a bigint")).toBe("not a bigint");
  });
});

describe("shortHex", () => {
  it("returns short strings untouched", () => {
    expect(shortHex("0xabc")).toBe("0xabc");
  });

  it("truncates a 0x-prefixed address with prefix/suffix", () => {
    expect(shortHex("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x123456…345678",
    );
  });

  it("truncates a long tx hash", () => {
    expect(shortHex("0x" + "a".repeat(64))).toBe("0xaaaaaa…aaaaaa");
  });
});
