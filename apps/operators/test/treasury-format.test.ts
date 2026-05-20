import { describe, expect, it } from "vitest";
import { formatPlatformFee } from "../app/treasury/page";

describe("formatPlatformFee", () => {
  it("renders … while the read is in flight (null)", () => {
    expect(formatPlatformFee(null)).toBe("…");
  });

  it("renders 0% for a zero-fee vault", () => {
    expect(formatPlatformFee(0)).toBe("0%");
  });

  it("renders 0.30% for 30 bps", () => {
    expect(formatPlatformFee(30)).toBe("0.3%");
  });

  it("renders 1% for 100 bps without trailing zeros", () => {
    expect(formatPlatformFee(100)).toBe("1%");
  });

  it("renders 5% for 500 bps", () => {
    expect(formatPlatformFee(500)).toBe("5%");
  });

  it("renders 10.25% for 1025 bps", () => {
    expect(formatPlatformFee(1025)).toBe("10.25%");
  });

  it("caps fractional precision at 2 digits (1234 bps → 12.34%)", () => {
    expect(formatPlatformFee(1234)).toBe("12.34%");
  });
});
