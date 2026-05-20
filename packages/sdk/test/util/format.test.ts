import { describe, expect, it, vi, afterEach } from "vitest";
import {
  shortTxHash,
  formatExpiry,
  formatTokenAmount,
  formatEther,
  bigintToHex,
  notePreimageToHex,
  notePreimageFromHex,
} from "../../src/util/format";

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

describe("formatTokenAmount", () => {
  it("short-circuits to integer string when decimals === 0", () => {
    expect(formatTokenAmount(12345n, 0)).toBe("12345");
  });

  it("guards against decimals < 0 instead of throwing", () => {
    // `10n ** BigInt(-1)` would throw — the helper falls back to
    // the integer form rather than letting a misconfigured token
    // crash the list view.
    expect(formatTokenAmount(42n, -1)).toBe("42");
  });

  it("trims trailing zeros from the fractional part", () => {
    // 1_500_000 / 10^6 = "1.5", not "1.500000".
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("renders integer values without a trailing dot", () => {
    expect(formatTokenAmount(2_000_000n, 6)).toBe("2");
  });

  it("zero-pads the fractional part to `decimals` width", () => {
    // 1 wei in 18-decimals → "0.000000000000000001".
    expect(formatTokenAmount(1n, 18)).toBe("0.000000000000000001");
  });

  it("renders negative amounts with a leading minus", () => {
    expect(formatTokenAmount(-1_500_000n, 6)).toBe("-1.5");
  });

  it("handles zero", () => {
    expect(formatTokenAmount(0n, 18)).toBe("0");
  });
});

describe("formatEther", () => {
  it("delegates to formatTokenAmount with 18 decimals", () => {
    // 1 ETH → "1" (note: NOT "1.0"; this helper trims trailing
    // zeros, which is why operators-side `bondEth` uses the
    // ethers-built `OperatorRow.bondEth` instead of this helper
    // when ".0" is required for visual consistency).
    expect(formatEther(10n ** 18n)).toBe("1");
    expect(formatEther(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(formatEther(0n)).toBe("0");
  });
});

describe("bigintToHex", () => {
  it("encodes zero as '0x0'", () => {
    expect(bigintToHex(0n)).toBe("0x0");
  });

  it("encodes positive bigints in lowercase hex", () => {
    expect(bigintToHex(255n)).toBe("0xff");
    expect(bigintToHex(0xdeadbeefn)).toBe("0xdeadbeef");
  });

  it("throws on negative bigints", () => {
    // `"0x-1"` is not a valid `BigInt(...)` argument, so the
    // round-trip would silently corrupt — fail loudly instead.
    expect(() => bigintToHex(-1n)).toThrow(/negative bigints/);
  });

  it("round-trips through BigInt()", () => {
    const v = 0x1234567890abcdef1234567890abcdefn;
    expect(BigInt(bigintToHex(v))).toBe(v);
  });
});

describe("notePreimageToHex / notePreimageFromHex", () => {
  const note = {
    ownerSecret: 0xaaaan,
    token: 0xbbbbn,
    amount: 1_000_000n,
    salt: 0xccccn,
    pubKeyAx: 0xddddn,
    pubKeyAy: 0xeeeen,
  };

  it("round-trips a v2 note (all fields populated)", () => {
    const hex = notePreimageToHex(note);
    expect(notePreimageFromHex(hex)).toEqual(note);
  });

  it("emits lowercase 0x-prefixed hex for every field", () => {
    const hex = notePreimageToHex(note);
    expect(hex.ownerSecret).toBe("0xaaaa");
    expect(hex.token).toBe("0xbbbb");
    expect(hex.amount).toBe("0xf4240"); // 1_000_000
    expect(hex.salt).toBe("0xcccc");
    expect(hex.pubKeyAx).toBe("0xdddd");
    expect(hex.pubKeyAy).toBe("0xeeee");
  });

  it("rejects a v1 note missing pubKeyAx/Ay with the canonical error", () => {
    // v1 notes (predating BabyJub binding) sit on disk in some
    // users' folders. The reader must throw the specific
    // "re-deposit required" message so the UI can surface it
    // instead of dropping the record silently.
    expect(() =>
      notePreimageFromHex({
        ownerSecret: "0x1",
        token: "0x2",
        amount: "0x3",
        salt: "0x4",
      }),
    ).toThrow(/Re-deposit required/);
    expect(() =>
      notePreimageFromHex({
        ownerSecret: "0x1",
        token: "0x2",
        amount: "0x3",
        salt: "0x4",
        pubKeyAx: "0x5",
        // pubKeyAy missing
      }),
    ).toThrow(/Re-deposit required/);
  });
});
