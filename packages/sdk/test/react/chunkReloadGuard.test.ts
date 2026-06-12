import { describe, it, expect } from "vitest";
import { isChunkLoadError } from "../../src/react/ChunkReloadGuard";

describe("isChunkLoadError", () => {
  it("matches by error name", () => {
    const e = new Error("anything");
    e.name = "ChunkLoadError";
    expect(isChunkLoadError(e)).toBe(true);
  });

  it("matches the message variants webpack/Turbopack/Next emit", () => {
    expect(isChunkLoadError(new Error("Loading chunk 42 failed."))).toBe(true);
    expect(
      isChunkLoadError(
        new Error(
          "Failed to load chunk /_next/static/chunks/apps_pay_app_layout_tsx_0ub2le~._.js",
        ),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new Error("ChunkLoadError: x"))).toBe(true);
  });

  it("matches bare strings (name lost across unhandledrejection)", () => {
    expect(isChunkLoadError("Loading chunk 7 failed")).toBe(true);
    expect(isChunkLoadError("ChunkLoadError")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isChunkLoadError(new Error("network request failed"))).toBe(false);
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(isChunkLoadError("some other message")).toBe(false);
  });

  it("is null/undefined safe", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
  });
});
