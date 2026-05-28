import { describe, expect, it } from "vitest";
import { explainError } from "../app/lib/format";

describe("explainError", () => {
  it("returns the message of a plain Error", () => {
    expect(explainError(new Error("boom"))).toBe("boom");
  });

  it("prefers ethers v6 shortMessage when present", () => {
    const err = new Error("very long full message with details");
    (err as { shortMessage?: string }).shortMessage = "execution reverted";
    expect(explainError(err)).toBe("execution reverted");
  });

  it("falls back to message when shortMessage is empty string", () => {
    // Empty-string guard — without it, the original `err.shortMessage ?? err.message`
    // returned the empty string and produced blank error banners.
    const err = new Error("real message");
    (err as { shortMessage?: string }).shortMessage = "";
    expect(explainError(err)).toBe("real message");
  });

  it("collapses newlines + tabs to single spaces", () => {
    expect(explainError(new Error("line1\n\tline2\n\nline3"))).toBe("line1 line2 line3");
  });

  it("truncates messages longer than the cap with an ellipsis", () => {
    const huge = "x".repeat(800);
    const out = explainError(new Error(huge));
    expect(out.length).toBeLessThanOrEqual(401); // 400 + 1 for ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles non-Error throws", () => {
    expect(explainError("string thrown")).toBe("string thrown");
    expect(explainError(42)).toBe("42");
  });
});
