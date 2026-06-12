import { describe, it, expect } from "vitest";
import { rehydrateBackoffMs } from "../../src/react/commitmentTree";

// The commitment tree's `refresh()` re-hydrates on demand, but a
// persistently-broken source (dead/forked RPC, indexer outage) makes
// every failed proof call refresh(). Without backoff that re-runs the
// hydrate effect in a tight loop — rebuilding a depth-20 tree and
// logging each time — which OOM'd the Next dev server via console
// forwarding. `rehydrateBackoffMs` is the formula that throttles it.
describe("rehydrateBackoffMs", () => {
  it("starts at 0.5s when healthy (streak 0) — only debounces bursts", () => {
    expect(rehydrateBackoffMs(0)).toBe(500);
  });

  it("doubles per consecutive failure", () => {
    expect(rehydrateBackoffMs(1)).toBe(1_000);
    expect(rehydrateBackoffMs(2)).toBe(2_000);
    expect(rehydrateBackoffMs(3)).toBe(4_000);
    expect(rehydrateBackoffMs(4)).toBe(8_000);
    expect(rehydrateBackoffMs(5)).toBe(16_000);
  });

  it("caps at 30s and never grows past it", () => {
    expect(rehydrateBackoffMs(6)).toBe(30_000); // 500 * 64 = 32000 -> capped
    expect(rehydrateBackoffMs(10)).toBe(30_000);
    expect(rehydrateBackoffMs(100)).toBe(30_000);
  });

  it("is monotonically non-decreasing in the streak", () => {
    let prev = 0;
    for (let s = 0; s <= 12; s++) {
      const cur = rehydrateBackoffMs(s);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});
