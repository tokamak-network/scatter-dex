import { describe, expect, it, vi, afterEach } from "vitest";
import { shortTxHash, formatExpiry } from "../../src/util/format";

describe("shortTxHash", () => {
  it("returns empty string for empty input", () => {
    expect(shortTxHash("")).toBe("");
  });

  it("returns the input verbatim when shorter than prefix+suffix+ellipsis", () => {
    // 17 chars with 10/6 defaults would produce a 17-char output
    // (10 + 1 ellipsis + 6) — no benefit, just harder to read.
    const seventeen = "0x" + "a".repeat(15);
    expect(seventeen.length).toBe(17);
    expect(shortTxHash(seventeen)).toBe(seventeen);
  });

  it("truncates the canonical 0x… + 64 hex form", () => {
    const txHash = "0x" + "abcd".repeat(16); // 66 chars
    expect(shortTxHash(txHash)).toBe("0xabcdabcd…cdabcd");
  });

  it("honors custom prefixLen / suffixLen", () => {
    const txHash = "0x" + "abcd".repeat(16);
    expect(shortTxHash(txHash, { prefixLen: 6, suffixLen: 4 })).toBe(
      "0xabcd…abcd",
    );
  });

  it("truncates when at the boundary of new len rule (18 chars)", () => {
    // 18 chars with 10/6 defaults → output is also 17 chars (10 + … + 6),
    // strictly shorter, so truncation should fire.
    const eighteen = "0x" + "a".repeat(16);
    expect(eighteen.length).toBe(18);
    const out = shortTxHash(eighteen);
    expect(out.length).toBeLessThan(eighteen.length);
    expect(out).toBe("0xaaaaaaaa…aaaaaa");
  });
});

describe("formatExpiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeNow(unixSec: number): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(unixSec * 1000));
  }

  it("returns 'expired' for past timestamps", () => {
    freezeNow(1000);
    expect(formatExpiry(500)).toBe("expired");
  });

  it("returns 'expired' for now (delta = 0)", () => {
    freezeNow(1000);
    expect(formatExpiry(1000)).toBe("expired");
  });

  it("returns '<1m' for sub-minute remaining (no '0m')", () => {
    freezeNow(1000);
    expect(formatExpiry(1030)).toBe("<1m"); // 30s left
    expect(formatExpiry(1059)).toBe("<1m"); // 59s left
  });

  it("renders minutes for sub-hour", () => {
    freezeNow(1000);
    expect(formatExpiry(1000 + 5 * 60)).toBe("5m"); // 5m
    expect(formatExpiry(1000 + 59 * 60)).toBe("59m");
  });

  it("renders 'Nh Mm' when both non-zero", () => {
    freezeNow(1000);
    expect(formatExpiry(1000 + 2 * 3600 + 15 * 60)).toBe("2h 15m");
  });

  it("collapses '1h 0m' to '1h'", () => {
    freezeNow(1000);
    expect(formatExpiry(1000 + 3 * 3600)).toBe("3h"); // exact hour
  });

  it("renders 'Nd Mh' when both non-zero", () => {
    freezeNow(1000);
    expect(formatExpiry(1000 + 2 * 24 * 3600 + 6 * 3600)).toBe("2d 6h");
  });

  it("collapses '1d 0h' to '1d'", () => {
    freezeNow(1000);
    expect(formatExpiry(1000 + 1 * 24 * 3600)).toBe("1d"); // exact 24h
  });
});
