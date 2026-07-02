import { describe, it, expect, vi } from "vitest";
import { createTtlSingleFlight } from "../src/lib/ttl-cache.js";

describe("createTtlSingleFlight", () => {
  it("coalesces concurrent callers into one fetch", async () => {
    let calls = 0;
    const get = createTtlSingleFlight(1000, async () => {
      calls++;
      return "v";
    });
    const results = await Promise.all([get(), get(), get()]);
    expect(results).toEqual(["v", "v", "v"]);
    expect(calls).toBe(1);
  });

  it("serves from cache within the TTL, refetches after it expires", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const get = createTtlSingleFlight(1000, async () => {
        calls++;
        return calls;
      });
      expect(await get()).toBe(1);
      vi.advanceTimersByTime(500);
      expect(await get()).toBe(1); // cache hit
      expect(calls).toBe(1);
      vi.advanceTimersByTime(600); // now past the 1000ms TTL
      expect(await get()).toBe(2); // refetched
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a rejection — the next call retries", async () => {
    let calls = 0;
    const get = createTtlSingleFlight(1000, async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    });
    await expect(get()).rejects.toThrow("boom");
    // Second call must re-run fetchFn (rejection was not cached).
    expect(await get()).toBe("ok");
    expect(calls).toBe(2);
  });
});
