import { describe, expect, it } from "vitest";
import { formatAge } from "../../src/react/LiveFreshness";

describe("formatAge", () => {
  const t = 1_700_000_000_000;
  it("formats seconds for sub-minute deltas", () => {
    expect(formatAge(t, t)).toBe("0s ago");
    expect(formatAge(t, t + 1000)).toBe("1s ago");
    expect(formatAge(t, t + 59_000)).toBe("59s ago");
  });
  it("formats minutes for sub-hour deltas", () => {
    expect(formatAge(t, t + 60_000)).toBe("1m ago");
    expect(formatAge(t, t + 59 * 60_000)).toBe("59m ago");
  });
  it("formats hours for sub-day deltas", () => {
    expect(formatAge(t, t + 60 * 60_000)).toBe("1h ago");
    expect(formatAge(t, t + 23 * 60 * 60_000)).toBe("23h ago");
  });
  it("formats days for ≥ 24h", () => {
    expect(formatAge(t, t + 24 * 60 * 60_000)).toBe("1d ago");
    expect(formatAge(t, t + 5 * 24 * 60 * 60_000)).toBe("5d ago");
  });
  it("clamps negative deltas (clock drift) to 0", () => {
    expect(formatAge(t, t - 5_000)).toBe("0s ago");
  });
});
